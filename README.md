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

## Auto-healing / Intent-based Healing

```js
const client = p3g.create({
  baseURL: 'https://api.exemplo.com',
  healing: {
    maxSteps: 4,
    paramAliases: { oldParam: 'newParam' },
    bodyAliases: { oldField: 'newField' }
  }
});

client.on('healed', (evt) => {
  console.log('Healing aplicado:', evt.reason, evt.from, evt.to);
});

const res = await client.get('/v1/legacy', {
  fallbackUrls: ['/v2/legacy'],
  intent: 'read'
});
```

Healing embutido:

- aumenta timeout automaticamente em timeout (`AbortError`)
- retry por status configuráveis (`408`, `429`, `5xx`, etc.)
- fallback de URL em `404`
- alias de campos/parâmetros em `422`
- estratégia por intenção (`read`, `write`, `delete`), incluindo downgrade de método em `405` para fluxos `write`
- regra customizada com `useHealingRule((ctx) => ...)`

## Outros recursos de resiliência

- **Auto-healing 401** com `onUnauthorizedRefresh`
- **Smart caching** via `memo(url, config, ttlMs)` com deduplicação de inflight
- **Circuit breaker** integrado (abre após N falhas)
- **Queue/throttling** via `defaults.queue.enabled` e `defaults.queue.delay`
- **Eventos de lifecycle**: `slow`, `retry`, `circuit:open`, `healed`

## Desenvolvimento

```bash
npm test
npm run lint
```
