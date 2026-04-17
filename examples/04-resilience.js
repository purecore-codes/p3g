import { createP3G } from '../src/index.js';

const api = createP3G({
  baseURL: 'https://jsonplaceholder.typicode.com',
  queue: {
    enabled: true,
    delay: 500 // 500ms entre requisições
  },
  circuitBreaker: {
    failureThreshold: 2, // Abre após 2 falhas
    openForMs: 5000     // Fica aberto por 5 segundos
  }
});

api.on('circuit:open', ({ openedAt }) => {
  console.warn('🚨 Circuito ABERTO! Evitando chamadas por 5s.');
});

async function runQueueDemo() {
  console.log('--- Demonstração de Fila ---');
  console.log('Disparando 3 requisições simultâneas (elas serão serializadas com delay de 500ms)...');
  
  const start = Date.now();
  
  const promises = [
    api.get('/posts/1'),
    api.get('/posts/2'),
    api.get('/posts/3')
  ];

  const results = await Promise.all(promises);
  const end = Date.now();

  console.log(`Finalizado em ${end - start}ms`);
  results.forEach((r, i) => console.log(`  Req ${i + 1} status: ${r.status}`));
}

async function runCircuitDemo() {
  console.log('\n--- Demonstração de Circuit Breaker ---');
  
  // Forçar falhas
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`Tentativa ${i + 1}...`);
      await api.get('https://google.com/error-404-forced-' + Math.random());
    } catch (error) {
      console.log(`  Erro capturado: ${error.message}`);
    }
  }

  // Próxima chamada deve ser bloqueada imediatamente pelo circuit breaker
  try {
    console.log('Tentando chamada com circuito aberto...');
    await api.get('/posts/1');
  } catch (error) {
    console.log(`  Bloqueio esperado: ${error.message}`);
  }
}

async function run() {
  await runQueueDemo();
  await runCircuitDemo();
}

run();
