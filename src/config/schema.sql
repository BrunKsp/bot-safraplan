-- Schema do bot-safraplan.
-- Guarda a sessão de cada número de WhatsApp (link com o cliente do backend-safraplan)
-- e o histórico de mensagens (contexto para a IA).

CREATE TABLE IF NOT EXISTS sessoes_whatsapp (
  id SERIAL PRIMARY KEY,
  celular VARCHAR(20) UNIQUE NOT NULL,
  cliente_id UUID NOT NULL,
  cliente_slug VARCHAR(255) NOT NULL,
  nome VARCHAR(200),
  token TEXT NOT NULL,
  token_criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
  fazenda_padrao_slug VARCHAR(255),
  contexto_pendente JSONB,
  criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mensagens (
  id SERIAL PRIMARY KEY,
  celular VARCHAR(20) NOT NULL,
  role VARCHAR(20) NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  criado_em TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mensagens_celular ON mensagens(celular, criado_em);
