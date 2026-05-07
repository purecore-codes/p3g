import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';

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
    this._debounces = new Map();
    this._throttles = new Map();
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
      deleteStrategy: 'soft', // 'soft' ou 'hard'
      softDeleteMethod: 'PATCH', // 'PATCH' ou 'PUT'
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

    const mergedConfig = { ...this.defaults, ...rawConfig };
    const method = (mergedConfig.method || 'GET').toUpperCase();
    const requestKey = `${method}:${mergedConfig.url}`;

    if (mergedConfig.throttle) {
      const lastCall = this._throttles.get(requestKey) || 0;
      const now = Date.now();
      if (now - lastCall < mergedConfig.throttle) {
        return Promise.reject(new Error(`Throttled: Request to ${requestKey} blocked.`));
      }
      this._throttles.set(requestKey, now);
    }

    if (mergedConfig.debounce) {
      return new Promise((resolve, reject) => {
        if (this._debounces.has(requestKey)) {
          clearTimeout(this._debounces.get(requestKey).timeout);
          this._debounces.get(requestKey).reject(new Error('Debounced'));
        }
        const timeout = setTimeout(async () => {
          this._debounces.delete(requestKey);
          try {
            const result = await this._processRequestAndQueue(rawConfig);
            resolve(result);
          } catch (e) {
            reject(e);
          }
        }, mergedConfig.debounce);
        this._debounces.set(requestKey, { timeout, resolve, reject });
      });
    }

    return this._processRequestAndQueue(rawConfig);
  }

  async _processRequestAndQueue(rawConfig) {
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

    return this._executeWithQueue(() => this._requestWithRetry(config), config);
  }

  async _requestWithRetry(config) {
    const retry = { ...this.defaults.retry, ...(config.retry || {}) };
    let maxRetries = retry.retries;
    if (maxRetries === 'outbox') {
      maxRetries = Infinity;
    }
    const dlqConfig = config.dlq || this.defaults.dlq || { threshold: Infinity };

    let attempt = 0;
    let activeConfig = config;
    let lastError;
    let dlqLogged = false;

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

          if (attempt >= dlqConfig.threshold && !dlqLogged) {
            try {
              const dlqLog = { timestamp: new Date().toISOString(), url: activeConfig.url, method: activeConfig.method, data: activeConfig.data, params: activeConfig.params, status: result.status, attempt };
              await fs.appendFile('dlq.json', JSON.stringify(dlqLog) + '\n');
              dlqLogged = true;
            } catch (e) { console.error('Failed to write to DLQ:', e); }
          }

          if (!retry.retryOn?.(result.status) || attempt === maxRetries) {
            this._registerFailure();
            const error = new HttpError(`Request falhou com status ${result.status}`, result, activeConfig);
            throw await this.interceptors.response.run(error, true);
          }

          let delayMs = retry.delay;
          if (Array.isArray(retry.delay) && retry.delay.length === 2) {
            delayMs = Math.floor(Math.random() * (retry.delay[1] - retry.delay[0] + 1)) + retry.delay[0];
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs * Math.max(1, attempt)));
          attempt += 1;
          continue;
        }

        this._registerSuccess();
        return this.interceptors.response.run(result);
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

        if (attempt >= dlqConfig.threshold && !dlqLogged) {
          try {
            const dlqLog = { timestamp: new Date().toISOString(), url: activeConfig.url, method: activeConfig.method, data: activeConfig.data, params: activeConfig.params, error: lastError.message, attempt };
            await fs.appendFile('dlq.json', JSON.stringify(dlqLog) + '\n');
            dlqLogged = true;
          } catch (e) { console.error('Failed to write to DLQ:', e); }
        }

        this._registerFailure();
        if (attempt === maxRetries) throw error;

        let delayMs = retry.delay;
        if (Array.isArray(retry.delay) && retry.delay.length === 2) {
          delayMs = Math.floor(Math.random() * (retry.delay[1] - retry.delay[0] + 1)) + retry.delay[0];
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
        attempt += 1;
      }
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

      if (raw.status === 401 && typeof config.onUnauthorizedRefresh === 'function' && !config._retryAfterRefresh) {
        await config.onUnauthorizedRefresh();
        clearTimeout(timeout);
        return this.request({ ...config, _retryAfterRefresh: true });
      }

      if (!config.validateStatus(raw.status)) {
        response._needsRetry = true;
        return response;
      }

      return response;
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
    const strategy = config.deleteStrategy || this.defaults.deleteStrategy;
    if (strategy === 'soft') {
      const method = config.softDeleteMethod || this.defaults.softDeleteMethod || 'PATCH';
      // In soft delete, we often send a body like { deletedAt: new Date() } 
      // but here we just route to the right method.
      return this.request({ ...config, method, url });
    }
    return this.hardDelete(url, config);
  }

  hardDelete(url, config = {}) {
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


async function fetchOpenApi(api) {
  try {
    const raw = await fetch(`${api}/openapi.json`);
    return await raw.json();
  } catch (e) {
    return null;
  }
}

function validatePayload(payload, schema, openapi) {
  if (!schema) return true;
  if (schema.$ref) {
    const refPath = schema.$ref.replace('#/', '').split('/');
    let resolved = openapi;
    for (const part of refPath) {
      if (resolved) resolved = resolved[part];
    }
    return validatePayload(payload, resolved, openapi);
  }
  if (schema.type === 'object' && schema.properties) {
    if (typeof payload !== 'object' || payload === null) return false;
    if (schema.required) {
      for (const req of schema.required) {
        if (payload[req] === undefined) return false;
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (payload[key] !== undefined) {
        if (!validatePayload(payload[key], propSchema, openapi)) return false;
      }
    }
  }
  if (schema.type === 'string' && typeof payload !== 'string') return false;
  if (schema.type === 'integer' && typeof payload !== 'number') return false;
  if (schema.type === 'number' && typeof payload !== 'number') return false;
  if (schema.type === 'boolean' && typeof payload !== 'boolean') return false;
  if (schema.type === 'array' && !Array.isArray(payload)) return false;

  return true;
}

function createP3G(config = {}) {
  const client = new P3GClient(config);

  const callable = async (url, configOrMethodOrData = {}, maybeConfigOrData = undefined, maybeConfig = undefined) => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    if (typeof configOrMethodOrData === 'string' && methods.includes(configOrMethodOrData.toUpperCase())) {
      const method = configOrMethodOrData.toUpperCase();
      const response = await client.request({ 
        ...maybeConfig,
        method, 
        url, 
        data: maybeConfigOrData 
      });
      return response.data;
    }
    if (typeof configOrMethodOrData === 'object' && !Array.isArray(configOrMethodOrData) && maybeConfigOrData === undefined) {
      const response = await client.get(url, configOrMethodOrData);
      return response.data;
    }
    const response = await client.post(url, configOrMethodOrData, maybeConfigOrData || {});
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

  if (config.api && config.entity) {
    let openapiCache = null;
    let openapiPromise = null;

    return new Proxy(callable, {
      get(target, prop) {
        const semanticMethods = ['list', 'get', 'create', 'update', 'delete'];
        if (prop in target && !semanticMethods.includes(prop)) {
          return target[prop];
        }

        return async (payloadOrParams) => {
          if (!openapiPromise) openapiPromise = fetchOpenApi(config.api);
          openapiCache = await openapiPromise;

          const paths = openapiCache?.paths || {};
          const resolvedBasePath = paths[`/${config.entity}s`] ? `/${config.entity}s` : `/${config.entity}`;

          if (prop === 'list') return (await client.get(resolvedBasePath, { params: payloadOrParams })).data;
          if (prop === 'get' && payloadOrParams?.id) return (await client.get(resolvedBasePath, { params: payloadOrParams })).data;
          if (prop === 'create') {
             const schema = paths[resolvedBasePath]?.post?.requestBody?.content?.['application/json']?.schema;
             if (schema && !validatePayload(payloadOrParams, schema, openapiCache)) throw new Error(`Invalid payload for create`);
             return (await client.post(resolvedBasePath, payloadOrParams)).data;
          }
          if (prop === 'update') {
             const schema = paths[resolvedBasePath]?.put?.requestBody?.content?.['application/json']?.schema;
             if (schema && !validatePayload(payloadOrParams, schema, openapiCache)) throw new Error(`Invalid payload for update`);
             return (await client.put(resolvedBasePath, payloadOrParams)).data;
          }
          if (prop === 'delete') {
             return (await client.delete(resolvedBasePath, { data: payloadOrParams })).data;
          }

          const customPath = `${resolvedBasePath}/${prop}`;
          if (paths[customPath]?.post) {
            const schema = paths[customPath].post.requestBody?.content?.['application/json']?.schema;
            if (schema && !validatePayload(payloadOrParams, schema, openapiCache)) throw new Error(`Invalid payload for ${prop}`);
            return (await client.post(customPath, payloadOrParams)).data;
          }
          if (paths[customPath]?.get) {
            return (await client.get(customPath, { params: payloadOrParams })).data;
          }

          if (prop in target) return target[prop];

          throw new Error(`Method ${prop} not found in OpenAPI or standard mapping`);
        };
      }
    });
  }

  return callable;
}

const p3g = createP3G();

export { createP3G, P3GClient, HttpError };
export default p3g;
