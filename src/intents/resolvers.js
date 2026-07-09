// Resolve nomes em texto livre (fazenda, categoria, produto) para os slugs que a API do
// backend-safraplan espera, usando os dados cadastrados de cada cliente.

const backendClient = require('../services/backendClient');

function normalizar(texto) {
  return (texto || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function encontrarPorNome(lista, campoNome, textoBusca) {
  if (!textoBusca) return null;
  const alvo = normalizar(textoBusca);
  return (
    lista.find((item) => normalizar(item[campoNome]) === alvo) ||
    lista.find((item) => normalizar(item[campoNome]).includes(alvo) || alvo.includes(normalizar(item[campoNome])))
  );
}

// Resolve a fazenda a ser usada: por nome mencionado, pela fazenda padrão salva na sessão,
// pela única fazenda existente, ou pede para o produtor escolher.
async function resolverFazenda(sessao, token, textoFazenda) {
  const fazendas = await backendClient.listarFazendas(token);

  if (fazendas.length === 0) {
    return { erro: 'Você ainda não tem nenhuma fazenda cadastrada no SafraPlan. Cadastre uma pelo aplicativo antes de registrar dados por aqui.' };
  }

  if (textoFazenda) {
    const encontrada = encontrarPorNome(fazendas, 'nome', textoFazenda);
    if (encontrada) return { fazenda: encontrada };
    return { erro: `Não encontrei nenhuma fazenda chamada "${textoFazenda}". Suas fazendas cadastradas: ${fazendas.map((f) => f.nome).join(', ')}.` };
  }

  if (sessao.fazenda_padrao_slug) {
    const padrao = fazendas.find((f) => f.slug === sessao.fazenda_padrao_slug);
    if (padrao) return { fazenda: padrao };
  }

  if (fazendas.length === 1) {
    return { fazenda: fazendas[0] };
  }

  return {
    precisaEscolher: true,
    pergunta: `Você tem mais de uma fazenda cadastrada: ${fazendas.map((f) => f.nome).join(', ')}. Pra qual delas é isso?`,
  };
}

// Resolve a categoria por nome em texto livre; se não encontrar, cai para "Outros".
async function resolverCategoria(token, textoCategoria) {
  const categorias = await backendClient.listarCategorias(token);
  const encontrada = encontrarPorNome(categorias, 'nome', textoCategoria);
  if (encontrada) return encontrada;

  const outros = categorias.find((c) => normalizar(c.nome) === 'outros');
  return outros || categorias[0];
}

// Resolve o produto por nome em texto livre.
async function resolverProduto(token, textoProduto) {
  const produtos = await backendClient.listarProdutos(token, textoProduto);
  const encontrado = encontrarPorNome(produtos, 'nome', textoProduto);
  if (encontrado) return { produto: encontrado };

  return {
    erro: `Não encontrei o produto "${textoProduto}" no catálogo. Produtos disponíveis: ${produtos.map((p) => p.nome).join(', ') || '(nenhum cadastrado ainda)'}.`,
  };
}

module.exports = { resolverFazenda, resolverCategoria, resolverProduto, normalizar };
