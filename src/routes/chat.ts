// Acesso direto ao mesmo motor de conversa do WhatsApp (sessão + histórico + IA + handlers),
// só que por HTTP puro — sem passar pela Meta/WAHA. Protegido pelo JWT que o cliente já usa
// no restante do SafraPlan.
//
// Diferente do fluxo real de WhatsApp (que não tem token e precisa se autenticar no
// backend-safraplan só com o celular via `/auth/whatsapp`), aqui o chamador já está autenticado
// — então a sessão local é criada/atualizada direto a partir do próprio token da requisição
// (clienteId + slug, decodificados pelo middleware), sem nenhuma chamada extra ao backend.
// O celular no corpo é opcional: se vier, é usado só como identificador da sessão/histórico (e
// pra dar suporte, no futuro, ao mesmo número falar pelo WhatsApp de verdade); se não vier, o
// bot busca a sessão já existente pelo clienteId do próprio token — só funciona se o cliente já
// tiver mandado mensagem (com celular) pelo menos uma vez antes.
import express, { Request, Response } from 'express';
import autenticarCliente from '../middlewares/autenticarCliente';
import * as session from '../services/session';
import * as history from '../services/history';
import { handleMessage } from '../services/conversation';
import { gerarInsightsDoMes } from '../services/insights';
import { SessaoWhatsapp } from '../database/entities/SessaoWhatsapp';

const router = express.Router();

router.use(autenticarCliente);

// Quando o corpo não informa `celular` (chat puro, sem WhatsApp), usa o clienteId do próprio
// token como identificador da sessão — não depende de número de telefone nenhum.
function identificadorSessao(req: Request, celular?: string): string {
  return celular || `cliente:${req.clienteIdToken}`;
}

async function resolverSessaoAutorizada(req: Request, res: Response, celular?: string): Promise<SessaoWhatsapp | null> {
  const identificador = identificadorSessao(req, celular);
  let sessao: SessaoWhatsapp | null;

  try {
    sessao = await session.buscarSessao(identificador);

    if (!sessao) {
      // Primeira mensagem dessa sessão: cria a partir do próprio token da requisição (já
      // autenticado), sem chamar o backend-safraplan de novo.
      sessao = await session.criarOuAtualizarSessao(identificador, {
        clienteId: req.clienteIdToken!,
        clienteSlug: req.clienteSlugToken || '',
        nome: null,
        token: req.clienteToken!,
      });
    } else if (sessao.token !== req.clienteToken) {
      sessao = await session.sincronizarToken(sessao, req.clienteToken!);
    }
  } catch (err: any) {
    console.error(`Erro ao resolver sessão de ${identificador}:`, err.response?.data || err.message);
    res.status(500).json({ erro: 'Tive um problema para confirmar sua conta no SafraPlan agora. Tenta de novo em instantes?' });
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
    const resposta = await handleMessage({ celular: sessao.celular, texto: mensagem.trim() });
    res.json({ resposta });
  } catch (err: any) {
    console.error(`Erro ao processar mensagem direta de ${sessao.celular}:`, err.response?.data || err.message);
    res.status(500).json({ erro: 'Tive um problema para processar essa mensagem agora. Tenta de novo em instantes?' });
  }
});

router.get('/historico', async (req: Request, res: Response) => {
  const celular = typeof req.query.celular === 'string' ? req.query.celular : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  const sessao = await resolverSessaoAutorizada(req, res, celular);
  if (!sessao) return;

  try {
    const mensagens = await history.getHistorico(sessao.celular, limit);
    res.json({ mensagens });
  } catch (err: any) {
    console.error(`Erro ao buscar histórico de ${sessao.celular}:`, err.response?.data || err.message);
    res.status(500).json({ erro: 'Tive um problema para buscar o histórico agora. Tenta de novo em instantes?' });
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
    console.error(`Erro ao gerar insights de ${sessao.celular}:`, err.response?.data || err.message);
    res.status(500).json({ erro: 'Tive um problema para calcular seus insights agora. Tenta de novo em instantes?' });
  }
});

export default router;
