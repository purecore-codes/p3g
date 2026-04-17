import p3g from '../src/index.js';

// 1. Chamada direta (atalho para GET que retorna .data)
async function directGet() {
  console.log('--- Chamada Direta GET ---');
  try {
    const data = await p3g('https://jsonplaceholder.typicode.com/posts/1');
    console.log('Título:', data.title);
  } catch (error) {
    console.error('Erro:', error.message);
  }
}

// 2. Chamada direta para POST (p3g(url, data))
async function directPost() {
  console.log('\n--- Chamada Direta POST ---');
  try {
    const result = await p3g('https://jsonplaceholder.typicode.com/posts', {
      title: 'Novo Post',
      body: 'Conteúdo do post',
      userId: 1
    });
    console.log('Criado com ID:', result.id);
  } catch (error) {
    console.error('Erro:', error.message);
  }
}

// 3. Estilo Axios (retorna objeto de resposta completo)
async function axiosStyle() {
  console.log('\n--- Estilo Axios ---');
  try {
    const response = await p3g.get('https://jsonplaceholder.typicode.com/users', {
      params: { id: 1 }
    });
    console.log('Status:', response.status);
    console.log('Nome do Usuário:', response.data[0].name);
  } catch (error) {
    console.error('Erro:', error.message);
  }
}

async function run() {
  await directGet();
  await directPost();
  await axiosStyle();
}

run();
