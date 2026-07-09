// Serviço de integração com a API oficial do WhatsApp (Meta Cloud API).
// Documentação: https://developers.facebook.com/docs/whatsapp/cloud-api

const axios = require('axios');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

const meta = axios.create({
  baseURL: `https://graph.facebook.com/${API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

async function enviarTexto(celular, texto) {
  try {
    await meta.post('/messages', {
      messaging_product: 'whatsapp',
      to: celular,
      type: 'text',
      text: { body: texto },
    });
  } catch (err) {
    console.error('Erro ao enviar mensagem via Meta Cloud API:', err.response?.data || err.message);
    throw err;
  }
}

// Marca a mensagem recebida como lida e ativa o indicador de "digitando..." (fica visível por até
// 25s ou até a próxima mensagem ser enviada) — melhora a percepção de resposta enquanto a IA processa.
async function marcarComoLidaEDigitando(messageId) {
  try {
    await meta.post('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  } catch (err) {
    // Não é crítico — ignora falha silenciosamente.
  }
}

module.exports = { enviarTexto, marcarComoLidaEDigitando };
