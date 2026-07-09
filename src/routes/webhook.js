// Rota que recebe os eventos do WhatsApp — via WAHA (dev local) ou API oficial da Meta (produção),
// dependendo de WHATSAPP_PROVIDER ('waha' | 'meta', default 'meta').
//
// WAHA: configure o webhook da WAHA como
//   http://bot:3000/webhook/whatsapp?token=SEU_WEBHOOK_SECRET
// (feito automaticamente pelo docker-compose.yml em dev)
//
// Meta: configure no painel do Meta for Developers (WhatsApp > Configuration > Webhook):
//   Callback URL: https://SEU-BOT.onrender.com/webhook/whatsapp
//   Verify token: o mesmo valor de WHATSAPP_VERIFY_TOKEN
// A Meta assina cada POST com o header X-Hub-Signature-256 usando o App Secret — validamos
// essa assinatura abaixo em vez de um token na query string.

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { handleMessage } = require('../services/conversation');
const waha = require('../services/waha');
const meta = require('../services/meta');

function provider() {
  return process.env.WHATSAPP_PROVIDER || 'meta';
}

// A Meta chama esse GET uma única vez, ao salvar a configuração do webhook, para confirmar a posse do endpoint.
// A WAHA nunca chama GET, então esse handler é inofensivo quando WHATSAPP_PROVIDER=waha.
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function assinaturaMetaValida(req) {
  const assinatura = req.get('X-Hub-Signature-256');
  if (!assinatura || !req.rawBody) return false;

  const esperada = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  const bufAssinatura = Buffer.from(assinatura);
  const bufEsperada = Buffer.from(esperada);
  if (bufAssinatura.length !== bufEsperada.length) return false;
  return crypto.timingSafeEqual(bufAssinatura, bufEsperada);
}

async function processarMensagem({ celular, texto, marcarDigitando, enviarResposta }) {
  try {
    await marcarDigitando();
    const resposta = await handleMessage({ celular, texto });
    if (resposta) await enviarResposta(resposta);
  } catch (err) {
    console.error(`Erro ao processar mensagem de ${celular}:`, err.message);
    try {
      await enviarResposta('Tive um problema para processar sua mensagem agora. Tenta de novo em instantes?');
    } catch (fallbackErr) {
      console.error('Falha também no fallback:', fallbackErr.message);
    }
  }
}

async function handleWaha(req, res) {
  if (req.query.token !== process.env.WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }

  // A WAHA espera uma resposta rápida — processa a mensagem depois de responder.
  res.sendStatus(200);

  const { event, payload } = req.body || {};

  if (event !== 'message' || !payload) return;
  if (payload.fromMe) return; // ignora mensagens enviadas pelo próprio número do bot
  if (!payload.from || payload.from.endsWith('@g.us')) return; // ignora grupos
  if (!payload.body || !payload.body.trim()) return; // ignora mídia sem legenda, figurinhas etc.

  const celular = waha.extrairCelular(payload.from);

  await processarMensagem({
    celular,
    texto: payload.body.trim(),
    marcarDigitando: () => waha.marcarComoDigitando(celular),
    enviarResposta: (texto) => waha.enviarTexto(celular, texto),
  });
}

async function handleMeta(req, res) {
  if (!assinaturaMetaValida(req)) {
    return res.sendStatus(403);
  }

  // A Meta espera uma resposta rápida — processa a mensagem depois de responder.
  res.sendStatus(200);

  const valor = req.body?.entry?.[0]?.changes?.[0]?.value;
  const mensagem = valor?.messages?.[0];

  if (!mensagem) return; // status de entrega/leitura etc. — não é mensagem nova
  if (mensagem.type !== 'text') return; // ignora mídia, figurinhas etc.

  const celular = mensagem.from;
  const texto = mensagem.text?.body?.trim();
  if (!texto) return;

  await processarMensagem({
    celular,
    texto,
    marcarDigitando: () => meta.marcarComoLidaEDigitando(mensagem.id),
    enviarResposta: (resposta) => meta.enviarTexto(celular, resposta),
  });
}

router.post('/whatsapp', (req, res) => {
  if (provider() === 'waha') return handleWaha(req, res);
  return handleMeta(req, res);
});

module.exports = router;
