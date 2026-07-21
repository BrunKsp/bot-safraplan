// Resolve nomes em texto livre (fazenda, categoria, produto) para os slugs que a API do
// backend-safraplan espera, usando os dados cadastrados de cada cliente.

import * as backendClient from '../services/backendClient';
import { Categoria, Fazenda, Produto } from '../services/backendClient';
import { SessaoWhatsapp } from '../database/entities/SessaoWhatsapp';

export function normalizar(texto?: string | null): string {
  return (texto || '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function encontrarPorNome<T extends Record<string, unknown>>(lista: T[], campoNome: keyof T, textoBusca?: string): T | null {
  if (!textoBusca) return null;
  const alvo = normalizar(textoBusca);
  return (
    lista.find((item) => normalizar(String(item[campoNome])) === alvo) ||
    lista.find((item) => {
      const nome = normalizar(String(item[campoNome]));
      return nome.includes(alvo) || alvo.includes(nome);
    }) ||
    null
  );
}

export interface ResolucaoFazenda {
  erro?: string;
  precisaEscolher?: true;
  pergunta?: string;
  fazenda?: Fazenda;
}

// Resolve a fazenda a ser usada: por nome mencionado, pela fazenda padrão salva na sessão,
// pela única fazenda existente, ou pede para o produtor escolher.
export async function resolverFazenda(sessao: SessaoWhatsapp, token: string, textoFazenda?: string): Promise<ResolucaoFazenda> {
  const fazendas = await backendClient.listarFazendas(token);

  if (fazendas.length === 0) {
    return { erro: 'Você ainda não tem nenhuma fazenda cadastrada no SafraPlan. Cadastre uma pelo aplicativo antes de registrar dados por aqui.' };
  }

  if (textoFazenda) {
    const encontrada = encontrarPorNome(fazendas, 'nome', textoFazenda);
    if (encontrada) return { fazenda: encontrada };
    return { erro: `Não encontrei nenhuma fazenda chamada "${textoFazenda}". Suas fazendas cadastradas: ${fazendas.map((f) => f.nome).join(', ')}.` };
  }

  if (sessao.fazendaPadraoSlug) {
    const padrao = fazendas.find((f) => f.slug === sessao.fazendaPadraoSlug);
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

function capitalizar(texto: string): string {
  return texto.trim().replace(/^\p{L}/u, (letra) => letra.toUpperCase());
}

// Resolve a categoria por nome em texto livre; se não encontrar nenhuma parecida entre as já
// cadastradas do cliente, cria uma nova categoria com esse nome (em vez de cair em "Outros" e
// mascarar o gasto real) — melhor a lista de categorias crescer do que perder a categorização.
export async function resolverCategoria(
  token: string,
  textoCategoria?: string,
  tipo: 'DESPESA' | 'RECEITA' | 'INSUMO' = 'DESPESA'
): Promise<Categoria> {
  const categorias = await backendClient.listarCategorias(token);
  const encontrada = encontrarPorNome(categorias, 'nome', textoCategoria);
  if (encontrada) return encontrada;

  if (textoCategoria?.trim()) {
    return backendClient.criarCategoria(token, { nome: capitalizar(textoCategoria), tipo });
  }

  const outros = categorias.find((c) => normalizar(c.nome) === 'outros');
  return outros || categorias[0];
}

export interface ResolucaoProduto {
  erro?: string;
  produto?: Produto;
}

// Resolve o produto por nome em texto livre.
export async function resolverProduto(token: string, textoProduto?: string): Promise<ResolucaoProduto> {
  const produtos = await backendClient.listarProdutos(token, textoProduto);
  const encontrado = encontrarPorNome(produtos, 'nome', textoProduto);
  if (encontrado) return { produto: encontrado };

  return {
    erro: `Não encontrei o produto "${textoProduto}" no catálogo. Produtos disponíveis: ${produtos.map((p) => p.nome).join(', ') || '(nenhum cadastrado ainda)'}.`,
  };
}
