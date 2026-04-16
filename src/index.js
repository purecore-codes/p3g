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

function withDefaults(value, fallback) {
  return value === undefined ? fallback : value;
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
      slowMs: 2_000,
      ...config
    };

    this.interceptors = {
      request: createInterceptors(),
      response: createInterceptors()
    };

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
      }
    });

    return this._executeWithQueue(() => this._requestWithRetry(config), config);
  }

  async _requestWithRetry(config) {
    const retry = { ...this.defaults.retry, ...(config.retry || {}) };
    const maxRetries = retry.retries;

    let attempt = 0;
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
