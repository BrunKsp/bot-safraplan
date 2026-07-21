// Cliente HTTP para o backend-safraplan.
// Duas formas de chamada:
//  - loginPorCelular(): autenticação de serviço, usa o segredo compartilhado (WHATSAPP_BOT_SECRET).
//  - todas as demais: autenticadas com o Bearer token do cliente (obtido via loginPorCelular).

import axios, { AxiosRequestConfig } from 'axios';

const api = axios.create({
  baseURL: process.env.BACKEND_API_URL,
  timeout: 15000,
});

export interface Cliente {
  slug: string;
  nomeCompleto: string;
  [campo: string]: unknown;
}

export interface LoginResultado {
  cliente: Cliente;
  token: string;
}

export interface Fazenda {
  slug: string;
  nome: string;
  [campo: string]: unknown;
}

export interface Categoria {
  id: string;
  slug: string;
  nome: string;
  [campo: string]: unknown;
}

export interface Produto {
  slug: string;
  nome: string;
  unidadeMedida: string;
  [campo: string]: unknown;
}

function comToken(token: string): AxiosRequestConfig {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// Autentica o número de WhatsApp no backend-safraplan. Retorna null se não houver
// cliente cadastrado com esse celular (404) — deixa outros erros propagarem.
export async function loginPorCelular(celular: string): Promise<LoginResultado | null> {
  try {
    const { data } = await api.post<LoginResultado>(
      '/auth/whatsapp',
      { celular },
      { headers: { 'x-integration-secret': process.env.WHATSAPP_BOT_SECRET } }
    );
    return data;
  } catch (err: any) {
    if (err.response?.status === 404) return null;
    console.error('Erro ao autenticar celular no backend-safraplan:', err.response?.data || err.message);
    throw err;
  }
}

export async function listarFazendas(token: string): Promise<Fazenda[]> {
  const { data } = await api.get<Fazenda[]>('/fazendas', comToken(token));
  return data;
}

export async function listarCategorias(token: string): Promise<Categoria[]> {
  const { data } = await api.get<Categoria[]>('/categorias', comToken(token));
  return data;
}

export async function criarCategoria(token: string, payload: { nome: string; tipo: 'DESPESA' | 'RECEITA' | 'INSUMO' }): Promise<Categoria> {
  const { data } = await api.post<Categoria>('/categorias', payload, comToken(token));
  return data;
}

export async function listarProdutos(token: string, busca?: string): Promise<Produto[]> {
  const { data } = await api.get<Produto[]>('/produtos', { ...comToken(token), params: busca ? { busca } : undefined });
  return data;
}

export async function listarSafras(token: string, fazendaSlug: string): Promise<unknown[]> {
  const { data } = await api.get(`/fazendas/${fazendaSlug}/safras`, comToken(token));
  return data;
}

export async function criarDespesa(token: string, payload: Record<string, unknown>): Promise<any> {
  const { data } = await api.post('/despesas', payload, comToken(token));
  return data;
}

export async function listarDespesas(token: string, params: Record<string, unknown>): Promise<any> {
  const { data } = await api.get('/despesas', { ...comToken(token), params });
  return data;
}

export async function criarContaPagar(token: string, payload: Record<string, unknown>): Promise<any> {
  const { data } = await api.post('/contas-pagar', payload, comToken(token));
  return data;
}

export async function criarContaReceber(token: string, payload: Record<string, unknown>): Promise<any> {
  const { data } = await api.post('/contas-receber', payload, comToken(token));
  return data;
}

export async function criarVenda(token: string, payload: Record<string, unknown>): Promise<any> {
  const { data } = await api.post('/vendas', payload, comToken(token));
  return data;
}

export async function listarContasPagar(token: string, params: Record<string, unknown>): Promise<any> {
  const { data } = await api.get('/contas-pagar', { ...comToken(token), params });
  return data;
}

export async function getResumoDashboard(token: string, params: Record<string, unknown>): Promise<any> {
  const { data } = await api.get('/dashboard/resumo', { ...comToken(token), params });
  return data;
}

export async function getPrecosMercado(token: string, fazendaSlug: string): Promise<any[]> {
  const { data } = await api.get(`/fazendas/${fazendaSlug}/precos-mercado`, comToken(token));
  return data;
}
