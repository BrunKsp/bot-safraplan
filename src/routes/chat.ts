// Acesso direto ao mesmo motor de conversa do WhatsApp (sessão + histórico + IA + handlers),
// só que por HTTP puro — sem passar pela Meta/WAHA. Protegido pelo JWT que o cliente já usa
// no restante do SafraPlan; o celular no corpo identifica de qual sessão/histórico reaproveitar.
import express, { Request, Response } from 'express';
import autenticarCliente from '../middlewares/autenticarCliente';
import * as session from '../services/session';
import { handleMessage } from '../services/conversation';
import { gerarInsightsDoMes } from '../services/insights';
import { SessaoWhatsapp } from '../database/entities/SessaoWhatsapp';

const router = express.Router();

router.use(autenticarCliente);

async function resolverSessaoAutorizada(req: Request, res: Response, celular: string): Promise<SessaoWhatsapp | null> {
  if (!celular) {
    res.status(400).json({ erro: 'Informe o celular no corpo da requisição.' });
    return null;
  }

  let sessao = await session.buscarSessao(celular);
  if (!sessao) {
    sessao = await session.autenticarCelular(celular);
  }

  if (!sessao) {
    res.status(404).json({ erro: 'Não encontrei nenhuma conta SafraPlan vinculada a este número.' });
    return null;
  }

  if (sessao.clienteId !== req.clienteIdToken) {
    res.status(403).json({ erro: 'Esse token não pertence a este número.' });
    return null;
  }

  return sessao;
}

router.post('/mensagem', async (req: Request, res: Response) => {
  const { celular, mensagem } = req.body || {};

  if (!mensagem || !mensagem.trim()) {
    return res.status(400).json({ erro: 'Informe a mensagem no corpo da requisição.' });
  }

  const sessao = await resolverSessaoAutorizada(req, res, celular);
  if (!sessao) return;

  try {
    const resposta = await handleMessage({ celular, texto: mensagem.trim() });
    res.json({ resposta });
  } catch (err: any) {
    console.error(`Erro ao processar mensagem direta de ${celular}:`, err.response?.data || err.message);
    res.status(500).json({ erro: 'Tive um problema para processar essa mensagem agora. Tenta de novo em instantes?' });
  }
});

router.post('/insights', async (req: Request, res: Response) => {
  const { celular } = req.body || {};

  const sessao = await resolverSessaoAutorizada(req, res, celular);
  if (!sessao) return;

  try {
    const { insights, resumo } = await gerarInsightsDoMes(sessao);
    res.json({ insights, resumo });
  } catch (err: any) {
    console.error(`Erro ao gerar insights de ${celular}:`, err.response?.data || err.message);
    res.status(500).json({ erro: 'Tive um problema para calcular seus insights agora. Tenta de novo em instantes?' });
  }
});

export default router;
