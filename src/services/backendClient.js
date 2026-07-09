// Cliente HTTP para o backend-safraplan.
// Duas formas de chamada:
//  - loginPorCelular(): autenticação de serviço, usa o segredo compartilhado (WHATSAPP_BOT_SECRET).
//  - todas as demais: autenticadas com o Bearer token do cliente (obtido via loginPorCelular).

const axios = require('axios');

const api = axios.create({
  baseURL: process.env.BACKEND_API_URL,
  timeout: 15000,
});

function comToken(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// Autentica o número de WhatsApp no backend-safraplan. Retorna null se não houver
// cliente cadastrado com esse celular (404) — deixa outros erros propagarem.
async function loginPorCelular(celular) {
  try {
    const { data } = await api.post(
      '/auth/whatsapp',
      { celular },
      { headers: { 'x-integration-secret': process.env.WHATSAPP_BOT_SECRET } }
    );
    return data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    console.error('Erro ao autenticar celular no backend-safraplan:', err.response?.data || err.message);
    throw err;
  }
}

async function listarFazendas(token) {
  const { data } = await api.get('/fazendas', comToken(token));
  return data;
}

async function listarCategorias(token) {
  const { data } = await api.get('/categorias', comToken(token));
  return data;
}

async function listarProdutos(token, busca) {
  const { data } = await api.get('/produtos', { ...comToken(token), params: busca ? { busca } : undefined });
  return data;
}

async function listarSafras(token, fazendaSlug) {
  const { data } = await api.get(`/fazendas/${fazendaSlug}/safras`, comToken(token));
  return data;
}

async function criarDespesa(token, payload) {
  const { data } = await api.post('/despesas', payload, comToken(token));
  return data;
}

async function listarDespesas(token, params) {
  const { data } = await api.get('/despesas', { ...comToken(token), params });
  return data;
}

async function criarContaPagar(token, payload) {
  const { data } = await api.post('/contas-pagar', payload, comToken(token));
  return data;
}

async function criarContaReceber(token, payload) {
  const { data } = await api.post('/contas-receber', payload, comToken(token));
  return data;
}

async function criarVenda(token, payload) {
  const { data } = await api.post('/vendas', payload, comToken(token));
  return data;
}

async function listarContasPagar(token, params) {
  const { data } = await api.get('/contas-pagar', { ...comToken(token), params });
  return data;
}

async function getResumoDashboard(token, params) {
  const { data } = await api.get('/dashboard/resumo', { ...comToken(token), params });
  return data;
}

async function getPrecosMercado(token, fazendaSlug) {
  const { data } = await api.get(`/fazendas/${fazendaSlug}/precos-mercado`, comToken(token));
  return data;
}

module.exports = {
  loginPorCelular,
  listarFazendas,
  listarCategorias,
  listarProdutos,
  listarSafras,
  criarDespesa,
  listarDespesas,
  criarContaPagar,
  criarContaReceber,
  criarVenda,
  listarContasPagar,
  getResumoDashboard,
  getPrecosMercado,
};
