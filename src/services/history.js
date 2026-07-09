// Histórico de mensagens por número de WhatsApp — usado como contexto para a IA.

const db = require('../config/database');

const HISTORY_LIMIT = 8;

async function getRecentHistory(celular) {
  const result = await db.query(
    `SELECT role, content
     FROM mensagens
     WHERE celular = $1
     ORDER BY criado_em DESC
     LIMIT $2`,
    [celular, HISTORY_LIMIT]
  );

  return result.rows.reverse().map((linha) => ({ role: linha.role, content: linha.content }));
}

async function salvarMensagem(celular, role, content) {
  await db.query('INSERT INTO mensagens (celular, role, content) VALUES ($1, $2, $3)', [celular, role, content]);
}

module.exports = { getRecentHistory, salvarMensagem };
