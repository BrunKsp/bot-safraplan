// Ponto de entrada do bot-safraplan.
// Fluxo: WhatsApp -> WAHA ou Meta Cloud API (conforme WHATSAPP_PROVIDER) -> POST /webhook/whatsapp
//        -> IA (OpenAI/Claude/NVIDIA) -> backend-safraplan -> resposta -> WhatsApp

import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { AppDataSource } from './database/data-source';
import webhookRouter from './routes/webhook';
import chatRouter from './routes/chat';

const app = express();
const PORT = process.env.PORT || 3000;

// /chat é chamado direto do navegador (ex: frontend-safraplan testando o bot) — sem isso o
// browser bloqueia a resposta por CORS. CORS_ORIGIN aceita uma lista separada por vírgulas; sem
// ela definida, libera qualquer origem (ok pra dev, defina em produção).
const origensPermitidas = process.env.CORS_ORIGIN?.split(',').map((origem) => origem.trim());
app.use(cors({ origin: origensPermitidas ?? true }));

// Guarda o body cru (antes do parse) — necessário para validar a assinatura HMAC (X-Hub-Signature-256)
// que a Meta envia em cada chamada de webhook.
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/webhook', webhookRouter);
app.use('/chat', chatRouter);

async function start() {
  await AppDataSource.initialize();

  app.listen(PORT, () => {
    console.log(`bot-safraplan rodando na porta ${PORT}`);
    console.log(`Webhook do WhatsApp (${process.env.WHATSAPP_PROVIDER || 'meta'}): GET/POST /webhook/whatsapp`);
    console.log(`Chat direto: POST /chat/mensagem, POST /chat/insights`);
    console.log(`Health check: GET /health`);
  });
}

start().catch((err) => {
  console.error('Falha ao iniciar o bot-safraplan:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err: any) => {
  console.error('Erro não tratado:', err.message);
});
