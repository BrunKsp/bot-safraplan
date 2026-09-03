// Serviço de integração com a Twilio (WhatsApp Business API) — usado quando WHATSAPP_PROVIDER=twilio,
// tanto para as respostas normais da conversa quanto para o envio do código OTP pedido pelo
// backend-safraplan (rota interna POST /interno/whatsapp/otp).
// Documentação: https://www.twilio.com/docs/whatsapp

import axios from 'axios';
import twilioSdk from 'twilio';

function client() {
  return twilioSdk(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Twilio identifica canais de WhatsApp prefixando o número com "whatsapp:" (ex: "whatsapp:+5511999999999").
function paraWhatsapp(celular: string): string {
  const normalizado = celular.replace(/\D/g, '');
  return celular.startsWith('whatsapp:') ? celular : `whatsapp:+${normalizado}`;
}

// Extrai só os dígitos do celular a partir do campo "From" do webhook da Twilio
// ("whatsapp:+5511999999999" -> "5511999999999").
function extrairCelular(campoFrom: string): string {
  return campoFrom.replace('whatsapp:', '').replace(/\D/g, '');
}

async function enviarTexto(celular: string, texto: string): Promise<void> {
  try {
    await client().messages.create({
      from: paraWhatsapp(process.env.TWILIO_WHATSAPP_NUMBER || ''),
      to: paraWhatsapp(celular),
      body: texto,
    });
  } catch (err: any) {
    console.error('Erro ao enviar mensagem via Twilio:', err.message);
    throw err;
  }
}

// Envia o código OTP usando um Content Template pré-aprovado pela Meta (obrigatório pra mensagens
// iniciadas pelo negócio, fora da janela de 24h de uma conversa em andamento) — texto livre não
// é entregue nesse caso. O template precisa ter uma única variável ({{1}}) para o código.
async function enviarOtp(celular: string, codigo: string): Promise<void> {
  const contentSid = process.env.TWILIO_OTP_CONTENT_SID;
  if (!contentSid) {
    throw new Error('TWILIO_OTP_CONTENT_SID não definido nas variáveis de ambiente.');
  }

  try {
    await client().messages.create({
      from: paraWhatsapp(process.env.TWILIO_WHATSAPP_NUMBER || ''),
      to: paraWhatsapp(celular),
      contentSid,
      contentVariables: JSON.stringify({ '1': codigo }),
    });
  } catch (err: any) {
    console.error('Erro ao enviar OTP via Twilio:', err.message);
    throw err;
  }
}

// Twilio não expõe indicador de "digitando..." pra WhatsApp via API — no-op, mantido só pra bater
// com a mesma interface usada por waha.ts/meta.ts no orquestrador do webhook.
async function marcarComoDigitando(_celular: string): Promise<void> {}

// Baixa uma mídia recebida (foto etc.) a partir da URL que a própria Twilio manda no payload do
// webhook (MediaUrl0) — essa URL exige autenticação básica com as mesmas credenciais da API.
async function baixarMidia(mediaUrl: string): Promise<Buffer> {
  const { data } = await axios.get<ArrayBuffer>(mediaUrl, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID || '',
      password: process.env.TWILIO_AUTH_TOKEN || '',
    },
  });
  return Buffer.from(data);
}

// Valida que o POST do webhook realmente veio da Twilio (assinatura X-Twilio-Signature).
function assinaturaValida(signatureHeader: string | undefined, url: string, params: Record<string, unknown>): boolean {
  if (!signatureHeader) return false;
  return twilioSdk.validateRequest(process.env.TWILIO_AUTH_TOKEN || '', signatureHeader, url, params);
}

export { enviarTexto, enviarOtp, marcarComoDigitando, extrairCelular, baixarMidia, assinaturaValida };
