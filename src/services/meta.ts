// Serviço de integração com a API oficial do WhatsApp (Meta Cloud API).
// Documentação: https://developers.facebook.com/docs/whatsapp/cloud-api

import axios from 'axios';

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

const meta = axios.create({
  baseURL: `https://graph.facebook.com/${API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

export async function enviarTexto(celular: string, texto: string): Promise<void> {
  try {
    await meta.post('/messages', {
      messaging_product: 'whatsapp',
      to: celular,
      type: 'text',
      text: { body: texto },
    });
  } catch (err: any) {
    console.error('Erro ao enviar mensagem via Meta Cloud API:', err.response?.data || err.message);
    throw err;
  }
}

// Marca a mensagem recebida como lida e ativa o indicador de "digitando..." (fica visível por até
// 25s ou até a próxima mensagem ser enviada) — melhora a percepção de resposta enquanto a IA processa.
export async function marcarComoLidaEDigitando(messageId: string): Promise<void> {
  try {
    await meta.post('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  } catch {
    // Não é crítico — ignora falha silenciosamente.
  }
}

// Baixa uma mídia recebida (foto etc.) a partir do media-id do webhook. A Cloud API funciona em
// dois passos: primeiro resolve o media-id para uma URL temporária assinada, depois baixa os bytes
// dessa URL — as duas chamadas exigem o mesmo Bearer token do sistema. Usamos URLs absolutas (o
// axios ignora a baseURL da instância `meta`, que aponta para o phone-number-id) já que o endpoint
// de mídia vive um nível acima na árvore da Graph API.
export async function baixarMidia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { data: info } = await meta.get<{ url: string; mime_type: string }>(
    `https://graph.facebook.com/${API_VERSION}/${mediaId}`,
  );

  const { data } = await meta.get<ArrayBuffer>(info.url, { responseType: 'arraybuffer' });

  return { buffer: Buffer.from(data), mimeType: info.mime_type };
}
