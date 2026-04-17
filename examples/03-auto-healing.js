import { createP3G } from '../src/index.js';

const client = createP3G({
  baseURL: 'https://jsonplaceholder.typicode.com',
  healing: {
    maxSteps: 3,
    paramAliases: { oldId: 'id' },
    bodyAliases: { oldTitle: 'title' }
  }
});

client.on('healed', (evt) => {
  console.log('🩹 Cura aplicada!');
  console.log(`  Motivo: ${evt.reason}`);
  console.log(`  De: ${evt.from.url} (${evt.from.method})`);
  console.log(`  Para: ${evt.to.url} (${evt.to.method})`);
});

async function run() {
  console.log('--- Testando Fallback de URL ---');
  // Tentará /rota-inexistente, falhará com 404, e usará o fallback /posts/1
  try {
    const res = await client.get('/rota-inexistente', {
      fallbackUrls: ['/posts/1']
    });
    console.log('Resultado do fallback:', res.data.title);
  } catch (error) {
    console.error('Falhou mesmo com fallback:', error.message);
  }

  console.log('\n--- Testando Alias de Parâmetros (422 Simulation) ---');
  // Se a API retornasse 422, o p3g tentaria trocar 'oldId' por 'id'
  // Como JSONPlaceholder não retorna 422 facilmente sem um mock, 
  // este exemplo demonstra a configuração.
  try {
    await client.get('/posts', {
      params: { oldId: 1 }
    });
  } catch (e) {}

  console.log('\n--- Testando Intent Strategy (Downgrade de Método) ---');
  // Se enviarmos POST para uma rota que só aceita PUT (405), 
  // com intent 'write', ele tenta o downgrade se configurado.
  try {
    await client.request({
      url: '/posts/1',
      method: 'POST',
      data: { title: 'Update' },
      intent: 'write'
    });
  } catch (e) {
    console.log('Nota: JSONPlaceholder pode não retornar 405 para POST em /posts/1, mas a lógica de healing foi armada.');
  }
}

run();
