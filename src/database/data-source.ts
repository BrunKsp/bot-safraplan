// DataSource do bot: Postgres próprio (schema `chat`), separado dos dados de negócio que
// vivem no backend-safraplan. Guarda a sessão de cada número de WhatsApp e o histórico de
// mensagens (contexto para a IA).

import 'reflect-metadata';
import path from 'path';
import dotenv from 'dotenv';
import { DataSource } from 'typeorm';

// O `app.ts` também carrega o .env, mas o CLI do TypeORM (migration:run/generate/revert) importa
// este arquivo direto, sem passar pelo app.ts — sem isso, DB_HOST/DATABASE_URL ficam undefined.
dotenv.config();

// Aceita dois formatos de conexão:
//  - DATABASE_URL (connection string única) — usado pelo docker-compose local e pelo Postgres
//    gerenciado do Render (`fromDatabase.property: connectionString`).
//  - DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_NAME (variáveis discretas, mesmo padrão do
//    backend-safraplan) — usado para provedores externos como o Neon.
// Se DB_HOST estiver definido, ele tem prioridade.
const sslVar = process.env.DB_SSL ?? process.env.DATABASE_SSL;
const sslHabilitado = sslVar ? sslVar === 'true' : process.env.NODE_ENV === 'production';
const ssl = sslHabilitado ? { rejectUnauthorized: false } : false;

const conexao = process.env.DB_HOST
  ? {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
    }
  : { url: process.env.DATABASE_URL };

export const AppDataSource = new DataSource({
  type: 'postgres',
  ...conexao,
  ssl,
  schema: 'chat',
  entities: [path.join(__dirname, 'entities', '*.{js,ts}')],
  migrations: [path.join(__dirname, 'migrations', '*.{js,ts}')],
  migrationsTableName: 'migrations',
  synchronize: false,
  migrationsRun: true,
  logging: process.env.NODE_ENV === 'development',
});
