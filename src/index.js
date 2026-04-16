import { EventEmitter } from 'node:events';

class HttpError extends Error {
  constructor(message, response, config) {
    super(message);
    this.name = 'P3GHttpError';
    this.response = response;
    this.config = config;
    this.status = response?.status;
  }
}

const METHOD_HAS_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function withDefaults(value, fallback) {
  return value === undefined ? fallback : value;
}

function clonePlainObject(value) {
  if (!value || typeof value !== 'object') return {};
  if (Array.isArray(value)) return [...value];
  return { ...value };
}

function joinUrl(baseURL = '', url = '') {
  if (!baseURL) return url;
  if (!url) return baseURL;
  return `${baseURL.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

function appendParams(url, params) {
  if (!params || typeof params !== 'object') return url;
  const next = new URL(url, 'http://localhost');
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) next.searchParams.append(k, `${item}`);
      continue;
    }
    next.searchParams.set(k, `${v}`);
  }
  return url.startsWith('http') ? next.toString() : `${next.pathname}${next.search}`;
}

function createInterceptors() {
  const handlers = [];
  return {
    use(fulfilled, rejected) {
      handlers.push({ fulfilled, rejected });
      return handlers.length - 1;
    },
    eject(id) {
      if (handlers[id]) handlers[id] = null;
    },
    async run(initial, errorMode = false) {
      let payload = initial;
      for (const handler of handlers) {
        if (!handler) continue;
        if (!errorMode && handler.fulfilled) payload = await handler.fulfilled(payload);
        if (errorMode && handler.rejected) payload = await handler.rejected(payload);
      }
      return payload;
    }
  };
}

function inferIntent(config) {
  const method = (config.method || 'GET').toUpperCase();
  if (READ_METHODS.has(method)) return 'read';
  if (method === 'DELETE') return 'delete';
  return 'write';
}

function applyAliasMap(target, aliasMap = {}) {
  if (!target || typeof target !== 'object') return false;
  let changed = false;
  for (const [from, to] of Object.entries(aliasMap)) {
    if (target[from] !== undefined && target[to] === undefined) {
      target[to] = target[from];
      delete target[from];
      changed = true;
    }
  }
  return changed;
}

class P3GClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.defaults = {
      baseURL: '',
      headers: {},
      timeout: 15_000,
      validateStatus: (status) => status >= 200 && status < 300,
      retry: {
        retries: 0,
        delay: 250,
        retryOn: (status) => status === 408 || status === 429 || status >= 500
      },
      queue: {
        enabled: false,
        delay: 0
      },
      circuitBreaker: {
        failureThreshold: 5,
        openForMs: 30_000
      },
      healing: {
        enabled: true,
        maxSteps: 2,
        timeoutMultiplier: 1.8,
        statusRetries: {
          408: 1,
          425: 1,
          429: 1,
          500: 1,
          502: 2,
          503: 2,
          504: 2
        },
        paramAliases: {},
        bodyAliases: {},
        intentStrategies: {
          read: { allowMethodDowngrade: false },
          write: { allowMethodDowngrade: true },
          delete: { allowMethodDowngrade: false }
        }
      },
      slowMs: 2_000,
      ...config
    };

    this.interceptors = {
      request: createInterceptors(),
      response: createInterceptors()
    };

    this._healingRules = [];
    this._cache = new Map();
    this._inflight = new Map();
    this._queue = [];
    this._processingQueue = false;

    this._circuit = {
      state: 'closed',
      failures: 0,
      openedAt: 0
    };
  }

  create(config = {}) {
    return createP3G({ ...this.defaults, ...config });
  }

  useHealingRule(ruleFn) {
    if (typeof ruleFn !== 'function') throw new TypeError('healing rule deve ser função');
    this._healingRules.push(ruleFn);
    return this._healingRules.length - 1;
  }

  ejectHealingRule(index) {
    if (this._healingRules[index]) this._healingRules[index] = null;
  }

  _canAttemptRequest() {
    if (this._circuit.state === 'closed') return true;
    const elapsed = Date.now() - this._circuit.openedAt;
    if (elapsed >= this.defaults.circuitBreaker.openForMs) {
      this._circuit.state = 'half-open';
      return true;
    }
    return false;
  }

  _registerSuccess() {
    this._circuit.failures = 0;
    this._circuit.state = 'closed';
  }

  _registerFailure() {
    this._circuit.failures += 1;
    if (this._circuit.failures >= this.defaults.circuitBreaker.failureThreshold) {
      this._circuit.state = 'open';
      this._circuit.openedAt = Date.now();
      this.emit('circuit:open', { openedAt: this._circuit.openedAt });
    }
  }

  _enqueue(task) {
    this._queue.push(task);
    if (!this._processingQueue) {
      this._processingQueue = true;
      this._processQueue().finally(() => {
        this._processingQueue = false;
      });
    }
  }

  async _processQueue() {
    while (this._queue.length) {
      const next = this._queue.shift();
      await next();
      const delay = this.defaults.queue.delay;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async _executeWithQueue(fn, config) {
    const queueEnabled = withDefaults(config?.queue?.enabled, this.defaults.queue.enabled);
    if (!queueEnabled) return fn();

    return new Promise((resolve, reject) => {
      this._enqueue(async () => {
        try {
          const response = await fn();
          resolve(response);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  async request(rawConfig = {}) {
    if (!this._canAttemptRequest()) {
      throw new Error('Circuit breaker aberto: requisição bloqueada temporariamente.');
    }

    const config = await this.interceptors.request.run({
      ...this.defaults,
      ...rawConfig,
      headers: {
        ...(this.defaults.headers || {}),
        ...(rawConfig.headers || {})
      },
      _healing: {
        step: 0,
        stepsApplied: [],
        statusRetries: {},
        ...(rawConfig._healing || {})
      }
    });

    return this._executeWithQueue(() => this._requestWithRecovery(config), config);
  }

  async _requestWithRecovery(config) {
      }
    });

    return this._executeWithQueue(() => this._requestWithRetry(config), config);
  }

  async _requestWithRetry(config) {
    const retry = { ...this.defaults.retry, ...(config.retry || {}) };
    const maxRetries = retry.retries;

    let attempt = 0;
    let activeConfig = config;
    let lastError;

    while (attempt <= maxRetries) {
      if (attempt > 0) this.emit('retry', activeConfig, attempt);
      try {
        const result = await this._doFetch(activeConfig);

        if (result._needsRetry) {
          const healed = await this._maybeHeal(activeConfig, {
            type: 'status',
            status: result.status,
            response: result
          });
          if (healed) {
            activeConfig = healed;
            continue;
          }

          if (!retry.retryOn?.(result.status) || attempt === maxRetries) return result;
          await new Promise((resolve) => setTimeout(resolve, retry.delay * Math.max(1, attempt)));
          attempt += 1;
          continue;
        }

        return result;
      } catch (error) {
        lastError = error;

        const healed = await this._maybeHeal(activeConfig, {
          type: 'error',
          error
        });

        if (healed) {
          activeConfig = healed;
          continue;
        }

        if (attempt === maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, retry.delay * (attempt + 1)));
        attempt += 1;
      }
    let lastError;

    while (attempt <= maxRetries) {
      if (attempt > 0) this.emit('retry', config, attempt);
      try {
        const response = await this._doFetch(config);
        if (!retry.retryOn?.(response.status) || attempt === maxRetries) {
          return response;
        }
        await new Promise((resolve) => setTimeout(resolve, retry.delay * attempt));
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, retry.delay * (attempt + 1)));
      }
      attempt += 1;
    }

    throw lastError;
  }

  _createResponse(raw, data, config, requestInfo) {
    return {
      data,
      status: raw.status,
      statusText: raw.statusText,
      headers: Object.fromEntries(raw.headers.entries()),
      config,
      request: requestInfo
    };
  }

  async _doFetch(config) {
    const method = (config.method || 'GET').toUpperCase();
    const url = appendParams(joinUrl(config.baseURL, config.url), config.params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);

    const headers = { ...(config.headers || {}) };
    let body = config.data;

    if (body && METHOD_HAS_BODY.has(method) && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array) && !(body.pipe)) {
      headers['content-type'] = headers['content-type'] || 'application/json';
      body = JSON.stringify(body);
    }

    const startedAt = Date.now();

    try {
      const raw = await fetch(url, {
        method,
        headers,
        body: METHOD_HAS_BODY.has(method) ? body : undefined,
        signal: controller.signal
      });

      const elapsed = Date.now() - startedAt;
      if (elapsed >= this.defaults.slowMs) this.emit('slow', { url, method, elapsed });

      const contentType = raw.headers.get('content-type') || '';
      const data = contentType.includes('application/json') ? await raw.json() : await raw.text();
      const response = this._createResponse(raw, data, config, { url, method });

      const response = {
        data,
        status: raw.status,
        statusText: raw.statusText,
        headers: Object.fromEntries(raw.headers.entries()),
        config,
        request: { url, method }
      };

      if (raw.status === 401 && typeof config.onUnauthorizedRefresh === 'function' && !config._retryAfterRefresh) {
        await config.onUnauthorizedRefresh();
        return this.request({ ...config, _retryAfterRefresh: true });
      }

      if (!config.validateStatus(raw.status)) {
        response._needsRetry = true;
        return response;
        this._registerFailure();
        const error = new HttpError(`Request falhou com status ${raw.status}`, response, config);
        const transformedError = await this.interceptors.response.run(error, true);
        throw transformedError;
      }

      this._registerSuccess();
      return this.interceptors.response.run(response);
    } catch (err) {
      this._registerFailure();
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _maybeHeal(config, context) {
    const healing = { ...this.defaults.healing, ...(config.healing || {}) };
    if (!healing.enabled) return null;

    const currentMeta = {
      step: config._healing?.step || 0,
      stepsApplied: [...(config._healing?.stepsApplied || [])],
      statusRetries: { ...(config._healing?.statusRetries || {}) }
    };

    if (currentMeta.step >= healing.maxSteps) return null;

    const intent = config.intent || inferIntent(config);
    let nextConfig = {
      ...config,
      intent,
      params: clonePlainObject(config.params),
      data: clonePlainObject(config.data)
    };

    let healedStep = null;

    if (context.type === 'error' && context.error?.name === 'AbortError') {
      nextConfig.timeout = Math.round((config.timeout || this.defaults.timeout) * healing.timeoutMultiplier);
      healedStep = `timeout:x${healing.timeoutMultiplier}`;
    }

    if (!healedStep && context.type === 'status') {
      const status = context.status;
      const retries = currentMeta.statusRetries[status] || 0;
      const allowed = healing.statusRetries?.[status] || 0;
      if (allowed > retries) {
        currentMeta.statusRetries[status] = retries + 1;
        healedStep = `status-retry:${status}:${retries + 1}`;
      }

      if (!healedStep && status === 404 && Array.isArray(config.fallbackUrls) && config.fallbackUrls.length > 0) {
        const fallbackIndex = config._fallbackIndex || 0;
        if (fallbackIndex < config.fallbackUrls.length) {
          nextConfig.url = config.fallbackUrls[fallbackIndex];
          nextConfig._fallbackIndex = fallbackIndex + 1;
          healedStep = `fallback-url:${fallbackIndex}`;
        }
      }

      if (!healedStep && status === 422) {
        const bodyFixed = applyAliasMap(nextConfig.data, healing.bodyAliases);
        const paramsFixed = applyAliasMap(nextConfig.params, healing.paramAliases);
        if (bodyFixed || paramsFixed) healedStep = 'alias-map:422';
      }

      if (!healedStep && status === 405) {
        if (Array.isArray(config.fallbackUrls) && config.fallbackUrls.length > 0) {
          const fallbackIndex = config._fallbackIndex || 0;
          if (fallbackIndex < config.fallbackUrls.length) {
            nextConfig.url = config.fallbackUrls[fallbackIndex];
            nextConfig._fallbackIndex = fallbackIndex + 1;
            healedStep = `fallback-url-405:${fallbackIndex}`;
          }
        }

        if (!healedStep) {
          const strategy = healing.intentStrategies?.[intent];
          const method = (config.method || 'GET').toUpperCase();
          if (strategy?.allowMethodDowngrade && method === 'POST') {
            nextConfig.method = 'PUT';
            healedStep = 'method-downgrade:POST->PUT';
          }
        }
      }
    }

    if (!healedStep && this._healingRules.length) {
      for (const rule of this._healingRules) {
        if (!rule) continue;
        const result = await rule({ config: nextConfig, context, intent, defaults: this.defaults });
        if (!result) continue;
        nextConfig = { ...nextConfig, ...result.config };
        healedStep = result.reason || 'custom-rule';
        break;
      }
    }

    if (!healedStep) return null;

    const appliedKey = `${intent}:${healedStep}`;
    if (currentMeta.stepsApplied.includes(appliedKey)) return null;

    const healedConfig = {
      ...nextConfig,
      _healing: {
        ...currentMeta,
        step: currentMeta.step + 1,
        stepsApplied: [...currentMeta.stepsApplied, appliedKey]
      }
    };

    this.emit('healed', {
      intent,
      reason: healedStep,
      from: { method: config.method, url: config.url, timeout: config.timeout },
      to: { method: healedConfig.method, url: healedConfig.url, timeout: healedConfig.timeout }
    });

    return healedConfig;
  }

  memo(url, config = {}, ttlMs = 1_000) {
    const cacheKey = `${(config.method || 'GET').toUpperCase()}:${appendParams(joinUrl(config.baseURL || this.defaults.baseURL, url), config.params)}`;
    const now = Date.now();

    const cached = this._cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.value);

    if (this._inflight.has(cacheKey)) return this._inflight.get(cacheKey);

    const reqPromise = this.request({ ...config, method: 'GET', url })
      .then((response) => {
        this._cache.set(cacheKey, {
          value: response,
          expiresAt: now + ttlMs
        });
        return response;
      })
      .finally(() => {
        this._inflight.delete(cacheKey);
      });

    this._inflight.set(cacheKey, reqPromise);
    return reqPromise;
  }

  get(url, config = {}) {
    return this.request({ ...config, method: 'GET', url });
  }

  delete(url, config = {}) {
    return this.request({ ...config, method: 'DELETE', url });
  }

  head(url, config = {}) {
    return this.request({ ...config, method: 'HEAD', url });
  }

  options(url, config = {}) {
    return this.request({ ...config, method: 'OPTIONS', url });
  }

  post(url, data, config = {}) {
    return this.request({ ...config, method: 'POST', url, data });
  }

  put(url, data, config = {}) {
    return this.request({ ...config, method: 'PUT', url, data });
  }

  patch(url, data, config = {}) {
    return this.request({ ...config, method: 'PATCH', url, data });
  }

  // atalhos BR
  async venha(url, config = {}) {
    const response = await this.get(url, config);
    return response.data;
  }

  async p(url, config = {}) {
    return this.venha(url, config);
  }

  manda(url, data, config = {}) {
    return this.post(url, data, config);
  }

  va(url, data, config = {}) {
    return this.post(url, data, config);
  }
}

function createP3G(config = {}) {
  const client = new P3GClient(config);

  const callable = async (url, configOrData = {}, maybeConfig = undefined) => {
    // p3g('/rota') => GET + data
    if (typeof configOrData === 'object' && !Array.isArray(configOrData) && maybeConfig === undefined) {
      const response = await client.get(url, configOrData);
      return response.data;
    }

    // p3g('/rota', data, config) => POST
    const response = await client.post(url, configOrData, maybeConfig || {});
    return response.data;
  };

  Object.setPrototypeOf(callable, client);
  for (const key of Reflect.ownKeys(P3GClient.prototype)) {
    if (key === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(P3GClient.prototype, key);
    if (descriptor?.value instanceof Function) {
      callable[key] = client[key].bind(client);
    }
  }

  callable.defaults = client.defaults;
  callable.interceptors = client.interceptors;

  return callable;
}

const p3g = createP3G();

export { createP3G, P3GClient, HttpError };
export default p3g;
