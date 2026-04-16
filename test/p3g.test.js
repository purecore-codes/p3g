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
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseURL: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('compatibilidade axios + atalhos BR', async (t) => {
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
});
