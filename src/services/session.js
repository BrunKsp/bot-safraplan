// Gerencia a sessão de cada número de WhatsApp: o vínculo com o cliente do backend-safraplan
// (token JWT) e o contexto de uma conversa em andamento (ex: bot perguntou "qual fazenda?" e
// está esperando a resposta antes de terminar de registrar uma despesa).

const db = require('../config/database');
const { loginPorCelular } = require('./backendClient');
const { decodificarToken } = require('../utils/jwt');

// O backend-safraplan omite `id` do objeto `cliente` na resposta de login (mesmo padrão usado
// no login por e-mail/senha) — o clienteId só vem embutido no próprio token JWT (claim `sub`).

async function buscarSessao(celular) {
  const result = await db.query('SELECT * FROM sessoes_whatsapp WHERE celular = $1', [celular]);
  return result.rows[0] || null;
}

async function criarOuAtualizarSessao(celular, { clienteId, clienteSlug, nome, token }) {
  const existente = await buscarSessao(celular);

  if (existente) {
    const result = await db.query(
      `UPDATE sessoes_whatsapp
       SET cliente_id = $1, cliente_slug = $2, nome = $3, token = $4, token_criado_em = NOW(), atualizado_em = NOW()
       WHERE celular = $5
       RETURNING *`,
      [clienteId, clienteSlug, nome, token, celular]
    );
    return result.rows[0];
  }

  const result = await db.query(
    `INSERT INTO sessoes_whatsapp (celular, cliente_id, cliente_slug, nome, token)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [celular, clienteId, clienteSlug, nome, token]
  );
  return result.rows[0];
}

// Tenta autenticar o número no backend-safraplan (login por celular, sem senha — o WhatsApp
// verificado já é o fator de autenticação) e cria/atualiza a sessão local.
// Retorna null se não existir cliente cadastrado com esse celular.
async function autenticarCelular(celular) {
  const resultado = await loginPorCelular(celular);
  if (!resultado) return null;

  const { cliente, token } = resultado;
  const { sub: clienteId } = decodificarToken(token);

  return criarOuAtualizarSessao(celular, {
    clienteId,
    clienteSlug: cliente.slug,
    nome: cliente.nomeCompleto,
    token,
  });
}

async function salvarFazendaPadrao(celular, fazendaSlug) {
  await db.query('UPDATE sessoes_whatsapp SET fazenda_padrao_slug = $1, atualizado_em = NOW() WHERE celular = $2', [
    fazendaSlug,
    celular,
  ]);
}

async function salvarContextoPendente(celular, contexto) {
  await db.query(
    'UPDATE sessoes_whatsapp SET contexto_pendente = $1, atualizado_em = NOW() WHERE celular = $2',
    [contexto ? JSON.stringify(contexto) : null, celular]
  );
}

async function limparContextoPendente(celular) {
  await salvarContextoPendente(celular, null);
}

module.exports = {
  buscarSessao,
  autenticarCelular,
  salvarFazendaPadrao,
  salvarContextoPendente,
  limparContextoPendente,
};
