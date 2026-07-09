// Conexão com o PostgreSQL próprio do bot.
// Guarda apenas: sessão (celular -> cliente/token do backend-safraplan) e histórico de mensagens.
// Os dados de negócio (despesas, contas, vendas etc.) vivem no backend-safraplan.

const { Pool } = require('pg');

// Render exige SSL para conexões externas ao Postgres gerenciado.
// Em produção habilita por padrão; pode ser desligado com DATABASE_SSL=false (ex: docker-compose local).
const sslHabilitado = process.env.DATABASE_SSL
  ? process.env.DATABASE_SSL === 'true'
  : process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslHabilitado ? { rejectUnauthorized: false } : false,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Erro ao conectar no banco de dados:', err.message);
  } else {
    console.log('Banco de dados do bot conectado com sucesso.');
    release();
  }
});

module.exports = pool;
