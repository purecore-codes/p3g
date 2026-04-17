import p3g from '../src/index.js';

// p3g.venha(url) -> atalho para .get(url).data
async function venha() {
  console.log('--- .venha() ---');
  try {
    const post = await p3g.venha('https://jsonplaceholder.typicode.com/posts/1');
    console.log('Post recuperado:', post.title);
  } catch (error) {
    console.error('Erro no venha:', error.message);
  }
}

// p3g.p(url) -> atalho curto para .venha()
async function p() {
  console.log('\n--- .p() ---');
  try {
    const users = await p3g.p('https://jsonplaceholder.typicode.com/users');
    console.log('Total de usuários:', users.length);
  } catch (error) {
    console.error('Erro no p:', error.message);
  }
}

// p3g.manda(url, data) ou .va(url, data) -> atalhos para .post(url, data)
async function mandaEVa() {
  console.log('\n--- .manda() e .va() ---');
  try {
    const resManda = await p3g.manda('https://jsonplaceholder.typicode.com/posts', { msg: 'mandei' });
    console.log('Resposta manda:', resManda.data);

    const resVa = await p3g.va('https://jsonplaceholder.typicode.com/posts', { msg: 'vá' });
    console.log('Resposta vá:', resVa.data);
  } catch (error) {
    console.error('Erro no manda ou vá:', error.message);
  }
}

async function run() {
  await venha();
  await p();
  await mandaEVa();
}

run();
