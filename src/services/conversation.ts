// Orquestrador da conversa: liga sessão + histórico + IA + handlers de intenção.
// É o "maestro" do bot — chamado uma vez por mensagem recebida do WhatsApp.

import * as session from './session';
import * as history from './history';
import * as storage from './storage';
import * as onboarding from './onboarding';
import { extrairIntencao, classificarImagem, CamposExtraidos } from './ai';
import { tratarIntencao } from '../intents/handlers';
import { SessaoWhatsapp } from '../database/entities/SessaoWhatsapp';

const FALHA_IA: CamposExtraidos = {
  intent: 'NAO_ENTENDI',
  resposta: 'Tive um problema para entender sua mensagem agora. Tenta de novo em instantes?',
};

// A chamada ao provedor de IA (OpenAI/Anthropic/NVIDIA) é a parte mais sujeita a falhar sem
// aviso (modelo descontinuado, rate limit, instabilidade de rede) — sem isso, qualquer erro aqui
// derrubava a requisição inteira com um 500 genérico em vez de uma resposta conversacional.
async function extrairComFallback(fn: () => Promise<CamposExtraidos>, celular: string): Promise<CamposExtraidos> {
  try {
    return await fn();
  } catch (err: any) {
    console.error(`Erro ao chamar IA para ${celular}:`, err.response?.data || err.message);
    return FALHA_IA;
  }
}

// Roda `fn(sessao)` e, se o backend responder 401 (token expirado), tenta autenticar de novo
// pelo celular (login por celular não depende de senha, então dá pra renovar automaticamente)
// e roda uma única vez mais.
async function comRenovacaoDeToken<T>(sessao: SessaoWhatsapp, fn: (sessao: SessaoWhatsapp) => Promise<T>): Promise<T> {
  try {
    return await fn(sessao);
  } catch (err: any) {
    if (err.response?.status === 401) {
      const novaSessao = await session.autenticarCelular(sessao.celular);
      if (novaSessao) return fn(novaSessao);
    }
    throw err;
  }
}

// Resolve a sessão do celular, autenticando pela primeira vez se necessário.
async function resolverSessao(celular: string): Promise<SessaoWhatsapp | null> {
  const sessao = await session.buscarSessao(celular);
  if (sessao) return sessao;
  return session.autenticarCelular(celular);
}

// Trecho comum a mensagens de texto e de imagem: roda o handler da intenção, trata a pergunta
// pendente (quando falta algum campo) e persiste a resposta no histórico.
async function processarCampos(sessao: SessaoWhatsapp, celular: string, campos: CamposExtraidos): Promise<string> {
  let resultado;
  try {
    resultado = await comRenovacaoDeToken(sessao, (s) => tratarIntencao(s, campos));
  } catch (err: any) {
    console.error(`Erro ao processar mensagem de ${celular}:`, err.response?.data || err.message);
    resultado = { resposta: 'Tive um problema para registrar isso no sistema. Tenta de novo em instantes?' };
  }

  if (resultado.perguntar) {
    await session.salvarContextoPendente(celular, { campos: campos as unknown as Record<string, unknown>, perguntando: resultado.perguntar });
    await history.salvarMensagem(celular, 'assistant', resultado.pergunta!);
    return resultado.pergunta!;
  }

  await session.limparContextoPendente(celular);
  await history.salvarMensagem(celular, 'assistant', resultado.resposta!);
  return resultado.resposta!;
}

export async function handleMessage({ celular, texto }: { celular: string; texto: string }): Promise<string> {
  // Cadastro em andamento (respondendo a uma pergunta do onboarding) tem prioridade sobre
  // qualquer outra coisa — inclusive sobre uma sessão que porventura já exista.
  const etapaOnboarding = await onboarding.buscarEtapaAtual(celular);
  if (etapaOnboarding) {
    // Nunca grava a senha em texto puro no histórico de mensagens.
    const conteudoHistorico = etapaOnboarding === 'senha' ? '[senha oculta]' : texto;
    await history.salvarMensagem(celular, 'user', conteudoHistorico);
    const resposta = await onboarding.processarResposta(celular, texto);
    await history.salvarMensagem(celular, 'assistant', resposta);
    return resposta;
  }

  const sessao = await resolverSessao(celular);
  if (!sessao) {
    await history.salvarMensagem(celular, 'user', texto);
    const resposta = await onboarding.iniciar(celular);
    await history.salvarMensagem(celular, 'assistant', resposta);
    return resposta;
  }

  await history.salvarMensagem(celular, 'user', texto);

  let campos: CamposExtraidos;

  if (sessao.contextoPendente) {
    // A mensagem atual é a resposta à pergunta que o bot fez (ex: "qual fazenda?").
    const { campos: camposAnteriores, perguntando } = sessao.contextoPendente;
    campos = { ...camposAnteriores, [perguntando]: texto.trim() } as unknown as CamposExtraidos;
  } else {
    const historico = await history.getRecentHistory(celular);
    campos = await extrairComFallback(() => extrairIntencao(historico, texto), celular);
  }

  return processarCampos(sessao, celular, campos);
}

// Processa uma foto recebida (nota fiscal, recibo, comprovante etc.): classifica com IA de visão
// e sobe a imagem para o R2 em paralelo, anexando a URL resultante à despesa quando aplicável.
export async function handleImageMessage({
  celular,
  buffer,
  mimeType,
}: {
  celular: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<string> {
  const etapaOnboarding = await onboarding.buscarEtapaAtual(celular);
  if (etapaOnboarding) {
    return 'Ainda estou te ajudando a criar sua conta — responde por texto, por favor. 🙂';
  }

  const sessao = await resolverSessao(celular);
  if (!sessao) {
    await history.salvarMensagem(celular, 'user', '[foto enviada]');
    const resposta = await onboarding.iniciar(celular);
    await history.salvarMensagem(celular, 'assistant', resposta);
    return resposta;
  }

  await history.salvarMensagem(celular, 'user', '[foto enviada]');

  const base64 = buffer.toString('base64');

  const [campos, anexoUrl] = await Promise.all([
    extrairComFallback(() => classificarImagem(base64, mimeType), celular),
    storage.uploadImagem(buffer, celular, mimeType).catch((err) => {
      console.error(`Erro ao subir imagem para o R2 (${celular}):`, err.message);
      return undefined;
    }),
  ]);

  if (anexoUrl) campos.anexoUrl = anexoUrl;

  return processarCampos(sessao, celular, campos);
}
