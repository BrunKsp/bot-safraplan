// Garante que as tabelas do bot existem.
// Roda automaticamente no boot do app (idempotente: usa CREATE TABLE IF NOT EXISTS).
// Assim não é preciso um passo manual de migration no Render.

const fs = require('fs');
const path = require('path');
const pool = require('./database');

async function migrar() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Schema do bot verificado/aplicado com sucesso.');
}

module.exports = { migrar };
