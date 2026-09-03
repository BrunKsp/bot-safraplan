// Serviço de integração com a UAZAPI (uazapiGO) — usada quando WHATSAPP_PROVIDER=uazapi.
// Documentação: https://docs.uazapi.com (spec OpenAPI carregada dinamicamente pelo site, sem URL fixa pra linkar aqui).
// Autenticação: header "token" com o token da instância (não é Bearer nem apikey).

import axios from 'axios';

const uazapi = axios.create({
  baseURL: process.env.UAZAPI_SERVER_URL,
  headers: { token: process.env.UAZAPI_INSTANCE_TOKEN },
  timeout: 15000,
});

// A UAZAPI identifica conversas individuais como "<numero>@s.whatsapp.net" e grupos como "<id>@g.us".
function extrairCelular(chatId: string): string {
  return chatId.split('@')[0];
}

async function enviarTexto(celular: string, texto: string): Promise<void> {
  try {
    await uazapi.post('/send/text', {
      number: celular,
      text: texto,
    });
  } catch (err: any) {
    console.error('Erro ao enviar mensagem via UAZAPI:', err.response?.data || err.message);
    throw err;
  }
}

// Envia indicador de "digitando..." — melhora a percepção de resposta enquanto a IA processa.
async function marcarComoDigitando(celular: string): Promise<void> {
  try {
    await uazapi.post('/message/presence', {
      number: celular,
      presence: 'composing',
      delay: 30000,
    });
  } catch {
    // Não é crítico — ignora falha silenciosamente.
  }
}

// Baixa uma mídia recebida (foto etc.) a partir do messageid original (campo "messageid" do
// payload do webhook, não o "id" interno) — a UAZAPI decodifica e devolve em base64.
async function baixarMidia(messageid: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const { data } = await uazapi.post('/message/download', {
    id: messageid,
    return_base64: true,
    return_link: false,
  });

  return { buffer: Buffer.from(data.base64Data, 'base64'), mimeType: data.mimetype };
}

export { enviarTexto, marcarComoDigitando, extrairCelular, baixarMidia };
