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
