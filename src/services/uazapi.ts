// Serviço de integração com a UAZAPI (uazapiGO) — usada quando WHATSAPP_PROVIDER=uazapi.
// Formato de payload/endpoints confirmado contra uma integração já em produção (a documentação
// pública em docs.uazapi.com descreve um formato diferente, que nunca bateu com o real).
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

// Números precisam vir com o DDI (55) — o webhook já manda assim, mas ao responder é mais seguro
// garantir isso também (evita depender só do formato que a UAZAPI mandou de volta).
function normalizarNumero(celular: string): string {
  const digitos = celular.replace(/\D/g, '');
  return digitos.startsWith('55') ? digitos : `55${digitos}`;
}

async function enviarTexto(celular: string, texto: string): Promise<void> {
  try {
    await uazapi.post('/send/text', {
      number: normalizarNumero(celular),
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
      number: normalizarNumero(celular),
      presence: 'composing',
      delay: 30000,
    });
  } catch {
    // Não é crítico — ignora falha silenciosamente.
  }
}

export interface ConteudoMidiaUazapi {
  URL: string;
  mimetype: string;
  fileSHA256: string;
  fileEncSHA256: string;
  fileLength: number;
  mediaKey: string;
}

// Baixa uma mídia recebida (foto etc.) em dois passos: 1) POST /message/download devolve uma
// fileURL pública (a UAZAPI descriptografa a mídia do WhatsApp e hospeda temporariamente);
// 2) GET nessa URL baixa o arquivo de fato.
async function baixarMidia(messageid: string, conteudo: ConteudoMidiaUazapi): Promise<{ buffer: Buffer; mimeType: string }> {
  const { data } = await uazapi.post<{ fileURL: string; mimetype: string }>('/message/download', {
    id: messageid,
    messageid,
    url: conteudo.URL,
    mimetype: conteudo.mimetype,
    fileSHA256: conteudo.fileSHA256,
    fileEncSHA256: conteudo.fileEncSHA256,
    fileLength: conteudo.fileLength,
    mediaKey: conteudo.mediaKey,
  });

  const arquivo = await axios.get<ArrayBuffer>(data.fileURL, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(arquivo.data), mimeType: data.mimetype ?? conteudo.mimetype };
}

export { enviarTexto, marcarComoDigitando, extrairCelular, baixarMidia };
