import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createP3G } from '../src/index.js';

function startServer() {
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/users')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, query: req.url.split('?')[1] || '' }));
      return;
    }

    if (req.url === '/write') {
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }

    if (req.url === '/write2') {
      if (req.method === 'PUT') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, method: req.method }));
        return;
      }
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }

    if (req.url === '/missing') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'missing' }));
      return;
    }

    if (req.url === '/fallback-ok') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, fallback: true }));
      return;
    }

    if (req.url === '/send' && req.method === 'POST') {
      let payload = '';
      req.on('data', (chunk) => (payload += chunk));
      await once(req, 'end');
      res.setHeader('content-type', 'application/json');
      res.end(payload || '{}');
      return;
    }

    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: true }));
import { createP3G, P3GClient, HttpError } from '../src/index.js';

// Global state for the mock server to track across requests if needed
let retryCount = 0;
let memoCount = 0;

async function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (url.pathname === '/users') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, method: req.method, query: url.search }));
      return;
    }

    if (url.pathname === '/echo' && req.method === 'POST') {
      let payload = '';
      req.on('data', (chunk) => (payload += chunk));
      await once(req, 'end');
      res.setHeader('content-type', 'application/json');
      res.end(payload || '{}');
      return;
    }

    if (url.pathname === '/fail') {
      res.statusCode = 500;
      res.end('Error');
      return;
    }

    if (url.pathname === '/retry-test') {
      retryCount++;
      if (retryCount < 3) {
        res.statusCode = 503;
        res.end('Fail');
      } else {
        res.statusCode = 200;
        res.end('OK');
      }
      return;
    }

    if (url.pathname === '/memo-test') {
      memoCount++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ count: memoCount }));
      return;
    }

    if (url.pathname === '/private') {
      if (req.headers.authorization === 'Bearer token-novo') {
        res.end('Private Data');
      } else {
        res.statusCode = 401;
        res.end('Unauthorized');
      }
      return;
    }
    
    if (url.pathname === '/slow') {
        await new Promise(r => setTimeout(r, 100));
        res.end('Slow');
        return;
    }

    res.statusCode = 404;
    res.end('Not Found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('compatibilidade axios + atalhos BR', async (t) => {
test('HttpError class works correctly', () => {
  const response = { status: 404 };
  const config = { url: '/test' };
  const error = new HttpError('Not Found', response, config);
  
  assert.equal(error.name, 'P3GHttpError');
  assert.equal(error.status, 404);
  assert.equal(error.response, response);
  assert.equal(error.config, config);
});

test('Basic GET and search params', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL });

  const res = await p3g.get('/users', { params: { id: 1 } });
  assert.equal(res.status, 200);
  assert.match(res.data.query, /id=1/);

  const data = await p3g.venha('/users', { params: { id: 2 } });
  assert.match(data.query, /id=2/);

  const sent = await p3g.manda('/send', { msg: 'oi' });
  assert.equal(sent.data.msg, 'oi');

  const directData = await p3g('/users', { params: { id: 9 } });
  assert.match(directData.query, /id=9/);
});

test('memo deduplica requisição em voo', async (t) => {
  const res = await p3g.get('/users', { params: { a: 1, b: [2, 3] } });
  
  assert.equal(res.status, 200);
  assert.ok(res.data.query.includes('a=1'));
  assert.ok(res.data.query.includes('b=2'));
  assert.ok(res.data.query.includes('b=3'));
});

test('Basic POST with JSON body', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL });
  const body = { name: 'Antigravity' };
  const res = await p3g.post('/echo', body);
  
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, body);
});

test('Interceptors (Request & Response)', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL });

  const [a, b] = await Promise.all([
    p3g.memo('/users', { params: { id: 1 } }, 500),
    p3g.memo('/users', { params: { id: 1 } }, 500)
  ]);

  assert.equal(a.data.query, b.data.query);
});

test('intent-based healing faz fallback de rota em 404', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL });

  const res = await p3g.get('/missing', {
    fallbackUrls: ['/fallback-ok'],
    healing: { maxSteps: 3 }
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.fallback, true);
});

test('intent-based healing troca método em strategy de write', async (t) => {
  
  let reqCalled = false;
  p3g.interceptors.request.use((config) => {
    reqCalled = true;
    config.headers['X-Test'] = 'Interceptor';
    return config;
  });

  p3g.interceptors.response.use((res) => {
    res.intercepted = true;
    return res;
  });

  const res = await p3g.get('/users');
  assert.ok(reqCalled);
  assert.ok(res.intercepted);
});

test('Retry mechanism works', async (t) => {
  retryCount = 0; // Reset global state
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL, retry: { retries: 3, delay: 10 } });
  
  let retryEventCount = 0;
  p3g.on('retry', () => {
    retryEventCount++;
  });

  const res = await p3g.get('/retry-test');
  assert.equal(res.status, 200);
  assert.equal(retryEventCount, 2);
});

test('Circuit Breaker opens on failures', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ 
    baseURL, 
    circuitBreaker: { failureThreshold: 2, openForMs: 100 } 
  });

  let openEventFired = false;
  p3g.on('circuit:open', () => {
    openEventFired = true;
  });

  // Trigger 2 failures
  try { await p3g.get('/fail'); } catch {}
  try { await p3g.get('/fail'); } catch {}

  assert.ok(openEventFired);

  // Next call should be blocked immediately
  await assert.rejects(
    () => p3g.get('/users'),
    /Circuit breaker aberto/
  );
  
  // Wait for it to reset (half-open)
  await new Promise(r => setTimeout(r, 150));
  const res = await p3g.get('/users');
  assert.equal(res.status, 200);
});

test('Queue serializes requests', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ 
    baseURL, 
    queue: { enabled: true, delay: 50 } 
  });

  const start = Date.now();
  await Promise.all([
    p3g.get('/users'),
    p3g.get('/users')
  ]);
  const elapsed = Date.now() - start;

  // Should take at least 50ms due to queue delay
  assert.ok(elapsed >= 50);
});

test('Memoization deduplicates and caches', async (t) => {
  memoCount = 0; // Reset global state
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL });
  const healedEvents = [];
  p3g.on('healed', (evt) => healedEvents.push(evt));

  const res = await p3g.post('/write', { msg: 'x' }, {
    fallbackUrls: ['/write2'],
    healing: { maxSteps: 4 }
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.method, 'PUT');
  assert.ok(healedEvents.length >= 2);
  
  const [r1, r2] = await Promise.all([
    p3g.memo('/memo-test', {}, 500),
    p3g.memo('/memo-test', {}, 500)
  ]);

  assert.equal(memoCount, 1);
  assert.deepEqual(r1.data, r2.data);
  
  // Subsequent call after some time but before TTL
  const r3 = await p3g.memo('/memo-test', {}, 500);
  assert.equal(memoCount, 1);
});

test('Brazilian Shortcuts (Atalhos BR)', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL });

  // venha (GET -> data)
  const dataVenha = await p3g.venha('/users');
  assert.ok(dataVenha.ok);

  // p (alias for venha)
  const dataP = await p3g.p('/users');
  assert.ok(dataP.ok);

  // manda (POST)
  const resManda = await p3g.manda('/echo', { foo: 'bar' });
  assert.equal(resManda.data.foo, 'bar');

  // va (POST)
  const resVa = await p3g.va('/echo', { hello: 'world' });
  assert.equal(resVa.data.hello, 'world');
});

test('Unauthorized Refresh logic', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  let refreshed = false;
  const p3g = createP3G({ 
    baseURL,
    onUnauthorizedRefresh: async () => {
      refreshed = true;
      p3g.defaults.headers.Authorization = 'Bearer token-novo';
    }
  });

  const res = await p3g.get('/private');
  assert.equal(res.status, 200);
  assert.equal(res.data, 'Private Data');
  assert.ok(refreshed);
});

test('Timeout management', async (t) => {
    const { server, baseURL } = await startServer();
    t.after(() => server.close());
  
    const p3g = createP3G({ baseURL, timeout: 50 });
  
    await assert.rejects(
      () => p3g.get('/slow'),
      (err) => err.name === 'AbortError' || err.code === 'UND_ERR_ABORTED' || err.message.includes('aborted')
    );
});

test('Slow event emission', async (t) => {
    const { server, baseURL } = await startServer();
    t.after(() => server.close());
  
    const p3g = createP3G({ baseURL, slowMs: 50 });
    
    let slowDetected = false;
    p3g.on('slow', () => {
        slowDetected = true;
    });

    await p3g.get('/slow');
    assert.ok(slowDetected);
});
