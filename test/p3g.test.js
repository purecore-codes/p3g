import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createP3G, HttpError } from '../src/index.js';

// Global state for mock server
let retryCount = 0;
let memoCount = 0;

async function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Core routes
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

    // Healing & Fallback routes
    if (url.pathname === '/missing') {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'missing' }));
      return;
    }

    if (url.pathname === '/fallback-ok') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, fallback: true }));
      return;
    }

    if (url.pathname === '/write') {
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }

    if (url.pathname === '/write2') {
      if (req.method === 'PUT') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, method: req.method }));
        return;
      }
      res.statusCode = 405;
      res.end('Fail');
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

test('HttpError class works correctly', () => {
  const response = { status: 404 };
  const config = { url: '/test' };
  const error = new HttpError('Not Found', response, config);
  assert.equal(error.name, 'P3GHttpError');
  assert.equal(error.status, 404);
});

test('compatibilidade axios + atalhos BR', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL });

  const res = await p3g.get('/users', { params: { id: 1 } });
  assert.equal(res.status, 200);
  assert.match(res.data.query, /id=1/);

  const data = await p3g.venha('/users', { params: { id: 2 } });
  assert.match(data.query, /id=2/);

  const sent = await p3g.manda('/echo', { msg: 'oi' });
  assert.equal(sent.data.msg, 'oi');

  const directData = await p3g('/users', { params: { id: 9 } });
  assert.match(directData.query, /id=9/);
});

test('Interceptors work', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());
  const p3g = createP3G({ baseURL });
  
  let reqCalled = false;
  p3g.interceptors.request.use((config) => {
    reqCalled = true;
    return config;
  });

  await p3g.get('/users');
  assert.ok(reqCalled);
});

test('Retry mechanism works', async (t) => {
  retryCount = 0;
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL, retry: { retries: 3, delay: 10 } });
  const res = await p3g.get('/retry-test');
  assert.equal(res.status, 200);
});

test('Circuit Breaker opens on failures', async (t) => {
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL, circuitBreaker: { failureThreshold: 2, openForMs: 50 } });
  try { await p3g.get('/fail'); } catch {}
  try { await p3g.get('/fail'); } catch {}

  await assert.rejects(() => p3g.get('/users'), /Circuit breaker aberto/);
});

test('Memoization deduplicates and caches', async (t) => {
  memoCount = 0;
  const { server, baseURL } = await startServer();
  t.after(() => server.close());

  const p3g = createP3G({ baseURL });
  const [r1, r2] = await Promise.all([
    p3g.memo('/memo-test', {}, 500),
    p3g.memo('/memo-test', {}, 500)
  ]);

  assert.equal(memoCount, 1);
  assert.deepEqual(r1.data, r2.data);
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

test('intent-based healing troca método em strategy de write (POST -> PUT)', async (t) => {
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
  assert.ok(healedEvents.length >= 1);
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
  assert.ok(refreshed);
});

test('Slow event emission', async (t) => {
    const { server, baseURL } = await startServer();
    t.after(() => server.close());
    const p3g = createP3G({ baseURL, slowMs: 50 });
    let slowDetected = false;
    p3g.on('slow', () => { slowDetected = true; });
    await p3g.get('/slow');
    assert.ok(slowDetected);
});
