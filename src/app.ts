// Ponto de entrada do bot-safraplan.
// Fluxo: WhatsApp -> WAHA, Twilio ou Meta Cloud API (conforme WHATSAPP_PROVIDER) -> POST /webhook/whatsapp
//        -> IA (OpenAI/Claude/NVIDIA/OpenRouter) -> backend-safraplan -> resposta -> WhatsApp
// POST /interno/whatsapp/otp: rota interna, chamada pelo backend-safraplan pra disparar o código
// OTP de vínculo de WhatsApp via Twilio (não expõe usuários finais).

import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { AppDataSource } from './database/data-source';
import webhookRouter from './routes/webhook';
import chatRouter from './routes/chat';
import internoRouter from './routes/interno';

const KEEP_ALIVE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h — não evita a hibernação (15 min de ociosidade já é suficiente pro Render dormir), só reduz quanto tempo o serviço fica de fato acordado, pra não estourar o limite de horas do plano free.

// Ping periódico só pra reduzir o tempo total dormindo entre usos esporádicos — NÃO mantém o bot
// sempre acordado (isso consumiria as horas do plano free rápido demais). O cold start de
// 30-60s+ na primeira mensagem depois de um tempo parado continua acontecendo normalmente.
// RENDER_EXTERNAL_URL é definida automaticamente pelo Render em serviços web; sem ela (dev local),
// o ping simplesmente não roda.
function iniciarKeepAlive(): void {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;

  setInterval(() => {
    axios.get(`${url}/health`, { timeout: 15_000 }).catch(() => {
      // Não é crítico — só uma tentativa de manter o serviço acordado, uma falha ocasional é ok.
    });
  }, KEEP_ALIVE_INTERVAL_MS);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Necessário pra req.protocol refletir "https" corretamente atrás do proxy do Render — usado na
// validação de assinatura do webhook da Twilio (a URL precisa bater com a configurada lá).
app.set('trust proxy', true);

// /chat é chamado direto do navegador (ex: frontend-safraplan testando o bot) — sem isso o
// browser bloqueia a resposta por CORS. CORS_ORIGIN aceita uma lista separada por vírgulas; sem
// ela definida, libera qualquer origem (ok pra dev, defina em produção).
const origensPermitidas = process.env.CORS_ORIGIN?.split(',').map((origem) => origem.trim());
app.use(cors({ origin: origensPermitidas ?? true }));

// Guarda o body cru (antes do parse) — necessário para validar a assinatura HMAC (X-Hub-Signature-256)
// que a Meta envia em cada chamada de webhook.
// Limite elevado para 15mb porque POST /chat/imagem recebe a foto em base64 no corpo JSON.
app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));

// A Twilio manda o webhook de WhatsApp como application/x-www-form-urlencoded, não JSON —
// coexiste com o express.json() acima (cada parser só age no Content-Type correspondente).
app.use(express.urlencoded({ extended: false }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/webhook', webhookRouter);
app.use('/chat', chatRouter);
app.use('/interno', internoRouter);

async function start() {
  await AppDataSource.initialize();

  app.listen(PORT, () => {
    console.log(`bot-safraplan rodando na porta ${PORT}`);
    console.log(`Webhook do WhatsApp (${process.env.WHATSAPP_PROVIDER || 'meta'}): GET/POST /webhook/whatsapp`);
    console.log(`Chat direto: POST /chat/mensagem, POST /chat/imagem, POST /chat/insights`);
    console.log(`Interno (backend-safraplan): POST /interno/whatsapp/otp`);
    console.log(`Health check: GET /health`);
    iniciarKeepAlive();
  });
}

start().catch((err) => {
  console.error('Falha ao iniciar o bot-safraplan:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err: any) => {
  console.error('Erro não tratado:', err.message);
});
