# p3g

Cliente HTTP super leve com **dupla personalidade**:

- Compatibilidade de uso com Axios (`get`, `post`, `request`, interceptors etc.)
- Atalhos BR (`venha`, `manda`, `p`, `va` e chamada direta `p3g('/rota')`)

## Uso

```js
import p3g from 'p3g';

// estilo Axios
const res = await p3g.get('/users', { params: { id: 1 } });

// estilo p3g
const data = await p3g.venha('/status');
await p3g.manda('/webhook', { msg: 'top' });

// callable
const status = await p3g('/status');
```

## Recursos de resiliência

- **Auto-healing 401** com `onUnauthorizedRefresh`
- **Smart caching** via `memo(url, config, ttlMs)` com deduplicação de inflight
- **Circuit breaker** integrado (abre após N falhas)
- **Queue/throttling** via `defaults.queue.enabled` e `defaults.queue.delay`
- **Eventos de lifecycle**: `slow`, `retry`, `circuit:open`

## Desenvolvimento

```bash
npm test
npm run lint
```
