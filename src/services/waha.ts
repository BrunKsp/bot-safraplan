// Serviço de integração com a WAHA (WhatsApp HTTP API) — usado localmente para dev (WHATSAPP_PROVIDER=waha).
// Documentação: https://waha.devlike.pro

import axios from 'axios';

const waha = axios.create({
  baseURL: process.env.WAHA_URL,
  headers: { 'X-Api-Key': process.env.WAHA_API_KEY },
  timeout: 15000,
});

// A WAHA identifica conversas individuais como "<numero>@c.us" e grupos como "<id>@g.us".
function paraChatId(celular: string): string {
  return celular.includes('@') ? celular : `${celular}@c.us`;
}

// Extrai só os dígitos do celular a partir de um chatId ("5534999998888@c.us" -> "5534999998888").
function extrairCelular(chatId: string): string {
  return chatId.split('@')[0];
}

async function enviarTexto(celular: string, texto: string): Promise<void> {
  try {
    await waha.post('/api/sendText', {
      session: process.env.WAHA_SESSION || 'default',
      chatId: paraChatId(celular),
      text: texto,
    });
  } catch (err: any) {
    console.error('Erro ao enviar mensagem via WAHA:', err.response?.data || err.message);
    throw err;
  }
}

// Envia indicador de "digitando..." — melhora a percepção de resposta enquanto a IA processa.
async function marcarComoDigitando(celular: string): Promise<void> {
  try {
    await waha.post('/api/startTyping', {
      session: process.env.WAHA_SESSION || 'default',
      chatId: paraChatId(celular),
    });
  } catch {
    // Não é crítico — ignora falha silenciosamente.
  }
}

export { enviarTexto, marcarComoDigitando, paraChatId, extrairCelular };
