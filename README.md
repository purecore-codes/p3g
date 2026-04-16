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
# P3G - Cliente HTTP Super Leve 🚀

**P3G** (PureCore 3rd Gen Request) é um cliente HTTP ultra-leve construído sobre a API nativa `fetch` do Node.js. Ele oferece uma interface amigável e compatível com Axios, além de recursos avançados de resiliência e atalhos divertidos em português.

## ✨ Destaques

- 🚀 **Zero Dependências**: Usa apenas APIs nativas do Node.js.
- 🔄 **Retentativas Inteligentes**: Configuração de retry com backoff exponencial.
- 🛡️ **Circuit Breaker**: Proteção contra falhas em cascata e sobrecarga de serviços.
- 🚦 **Fila de Requisições**: Serialização de chamadas com atraso configurável.
- 🧠 **Memoização**: Cache inteligente para evitar requisições duplicadas "em voo".
- 🇧🇷 **Atalhos BR**: Sintaxe brasileira para quem gosta de um código mais expressivo.
- ⚡ **Compatível com Axios**: API familiar para fácil migração.

## 📦 Instalação

```bash
npm install p3g
# ou
yarn add p3g
```

## 🚀 Uso Básico

```javascript
import p3g from 'p3g';

// Chamada direta (atalho para GET)
const data = await p3g('https://api.github.com/users/purecore');
console.log(data.login);

// Chamada direta para POST
const result = await p3g('/api/users', { name: 'Dev' });
```

### Métodos Padrão (Estilo Axios)

```javascript
const response = await p3g.get('/users', { params: { id: 123 } });
const response = await p3g.post('/users', { name: 'João' });
const response = await p3g.put('/users/1', { name: 'João Silva' });
const response = await p3g.delete('/users/1');
```

## 🇧🇷 Atalhos BR (Just for fun)

Se você cansar do inglês, use nossos atalhos nativos:

```javascript
// GET -> Venha
const users = await p3g.venha('/users');

// GET + data direto -> p
const data = await p3g.p('/users');

// POST -> Manda ou Va
await p3g.manda('/webhook', { event: 'fired' });
await p3g.va('/chat', { msg: 'olá' });
```

## 🛠️ Configuração Avançada

Você pode criar instâncias personalizadas:

```javascript
import { createP3G } from 'p3g';

const api = createP3G({
  baseURL: 'https://api.exemplo.com',
  timeout: 5000,
  retry: {
    retries: 3,
    delay: 500
  },
  circuitBreaker: {
    failureThreshold: 5,
    openForMs: 60000
  }
});
```

### 🚦 Gerenciamento de Fila (Queue)

Útil para APIs com rate limit rigoroso.

```javascript
const api = createP3G({
  queue: {
    enabled: true,
    delay: 1000 // Espera 1 segundo entre cada requisição
  }
});

// As requisições serão executadas uma após a outra
api.get('/1');
api.get('/2');
```

### 🧠 Memoização (Cache)

Evita disparar requisições idênticas simultaneamente.

```javascript
// Se chamado 10x ao mesmo tempo, apenas 1 requisição real é feita
const data = await api.memo('/config', {}, 10000); // 10s de cache
```

### 🛡️ Circuit Breaker

O cliente monitora falhas. Se o limite for atingido, ele para de tentar por um tempo para poupar o servidor.

```javascript
api.on('circuit:open', ({ openedAt }) => {
  console.warn('Circuito aberto! Pequena pausa nas requisições.');
});
```

### 🔄 Interceptores

```javascript
api.interceptors.request.use((config) => {
  config.headers.Authorization = 'Bearer token-secreto';
  return config;
});

api.interceptors.response.use(
  (response) => {
    console.log('Sucesso:', response.status);
    return response;
  },
  (error) => {
    console.error('Erro na resposta:', error.message);
    throw error;
  }
);
```

## 📜 Licença

MIT
