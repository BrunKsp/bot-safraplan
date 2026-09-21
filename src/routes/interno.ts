// Rotas internas, chamadas só pelo backend-safraplan (nunca por usuários finais) — protegidas por
// autenticarServico (segredo compartilhado, header x-integration-secret).
import express, { Request, Response } from 'express';
import autenticarServico from '../middlewares/autenticarServico';
import * as twilio from '../services/twilio';
import * as uazapi from '../services/uazapi';
import * as waha from '../services/waha';

const router = express.Router();

router.use(autenticarServico);

function mensagemOtp(codigo: string): string {
  return `Seu código de verificação do SafraPlan é: ${codigo}\nEle expira em 5 minutos. Não compartilhe com ninguém.`;
}

// Twilio (canal oficial) exige um Content Template pré-aprovado pra mensagens iniciadas pelo
// negócio fora da janela de 24h — as demais integrações (WAHA/UAZAPI, não-oficiais) mandam texto
// livre sem essa restrição.
async function enviarOtpPeloProviderAtivo(celular: string, codigo: string): Promise<void> {
  const provider = process.env.WHATSAPP_PROVIDER || 'meta';

  if (provider === 'twilio') {
    return twilio.enviarOtp(celular, codigo);
  }

  if (provider === 'uazapi') {
    return uazapi.enviarTexto(celular, mensagemOtp(codigo));
  }

  if (provider === 'waha') {
    return waha.enviarTexto(celular, mensagemOtp(codigo));
  }

  throw new Error(`Envio de OTP não implementado para WHATSAPP_PROVIDER=${provider}.`);
}

router.post('/whatsapp/otp', async (req: Request, res: Response) => {
  const { celular, codigo } = req.body || {};

  if (!celular || !codigo) {
    return res.status(400).json({ erro: 'Informe celular e codigo no corpo da requisição.' });
  }

  try {
    await enviarOtpPeloProviderAtivo(celular, codigo);
    res.json({ enviado: true });
  } catch (err: any) {
    console.error(`Erro ao enviar OTP para ${celular}:`, err.response?.data || err.message);
    res.status(502).json({ erro: 'Não consegui enviar o código pelo WhatsApp agora.' });
  }
});

// Texto livre (avisos diários de cotação/clima etc.) — só funciona em provedores não-oficiais
// (UAZAPI/WAHA). Twilio/Meta exigem Content Template aprovado pra mensagens fora da janela de
// 24h de conversa, então mensagens de negócio "avulsas" como essa não são suportadas por eles
// aqui (ver enviarOtp, que já usa template pra contornar isso no caso do código OTP).
async function enviarTextoPeloProviderAtivo(celular: string, mensagem: string): Promise<void> {
  const provider = process.env.WHATSAPP_PROVIDER || 'meta';

  if (provider === 'uazapi') {
    return uazapi.enviarTexto(celular, mensagem);
  }

  if (provider === 'waha') {
    return waha.enviarTexto(celular, mensagem);
  }

  throw new Error(`Envio de texto livre não suportado para WHATSAPP_PROVIDER=${provider} (exige template aprovado).`);
}

router.post('/whatsapp/enviar', async (req: Request, res: Response) => {
  const { celular, mensagem } = req.body || {};

  if (!celular || !mensagem) {
    return res.status(400).json({ erro: 'Informe celular e mensagem no corpo da requisição.' });
  }

  try {
    await enviarTextoPeloProviderAtivo(celular, mensagem);
    res.json({ enviado: true });
  } catch (err: any) {
    console.error(`Erro ao enviar mensagem para ${celular}:`, err.response?.data || err.message);
    res.status(502).json({ erro: 'Não consegui enviar a mensagem pelo WhatsApp agora.' });
  }
});

export default router;
