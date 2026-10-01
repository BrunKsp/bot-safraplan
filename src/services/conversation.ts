// Orquestrador da conversa: liga sessão + histórico + IA + handlers de intenção.
// É o "maestro" do bot — chamado uma vez por mensagem recebida do WhatsApp.

import * as session from './session';
import * as history from './history';
import * as storage from './storage';
import * as onboarding from './onboarding';
import { extrairIntencao, classificarImagem, CamposExtraidos, FormaPagamento } from './ai';
import { tratarIntencao } from '../intents/handlers';
import { SessaoWhatsapp } from '../database/entities/SessaoWhatsapp';

const FALHA_IA: CamposExtraidos = {
  intent: 'NAO_ENTENDI',
  resposta: 'Tive um problema para entender sua mensagem agora. Tenta de novo em instantes?',
};

const PALAVRAS_AFIRMATIVAS = ['sim', 's', 'confirma', 'confirmar', 'confirmado', 'ok', 'certo', 'isso', 'correto', 'exato', 'positivo'];
const PALAVRAS_CANCELAMENTO_REGISTRO = ['não', 'nao', 'cancela', 'cancelar', 'errado'];

// Campo que o produtor pode corrigir na etapa de confirmação (ex: "categoria: combustível") ->
// nome real do campo em CamposExtraidos.
const CAMPOS_CORRIGIVEIS: Record<string, keyof CamposExtraidos> = {
  categoria: 'categoria',
  valor: 'valor',
  fazenda: 'fazenda',
  descricao: 'descricao',
  descrição: 'descricao',
  data: 'data',
  vencimento: 'dataVencimento',
  datavencimento: 'dataVencimento',
  'data de vencimento': 'dataVencimento',
  fornecedor: 'fornecedor',
  comprador: 'comprador',
  produto: 'produto',
  quantidade: 'quantidade',
  formapagamento: 'formaPagamento',
  'forma de pagamento': 'formaPagamento',
  parcelas: 'numeroParcelas',
  numeroparcelas: 'numeroParcelas',
};

const CAMPOS_NUMERICOS: Array<keyof CamposExtraidos> = ['valor', 'quantidade', 'numeroParcelas'];

const FORMAS_PAGAMENTO_PALAVRAS: Record<string, FormaPagamento> = {
  dinheiro: 'DINHEIRO',
  pix: 'PIX',
  cartao: 'CARTAO',
  cartão: 'CARTAO',
  boleto: 'BOLETO',
  financiamento: 'FINANCIAMENTO',
};

// A forma de pagamento tem que ser um dos valores fixos que o backend aceita — em vez de gravar
// o texto livre do produtor ("parcelado em 2x no boleto") direto, que quebraria a validação lá,
// procura uma palavra-chave conhecida dentro do texto.
function normalizarFormaPagamento(texto: string): FormaPagamento | undefined {
  const normalizado = texto.toLowerCase();
  for (const [palavra, forma] of Object.entries(FORMAS_PAGAMENTO_PALAVRAS)) {
    if (normalizado.includes(palavra)) return forma;
  }
  return undefined;
}

interface Correcao {
  campo: keyof CamposExtraidos;
  valor: string | number;
}

// Reconhece uma ou mais correções "campo: valor" (uma por linha) na resposta à confirmação —
// ex: "categoria: combustível" ou várias linhas de uma vez ("categoria: Insumos\nfazenda: Sede").
function interpretarCorrecoes(texto: string): Correcao[] {
  const linhas = texto.split('\n').map((linha) => linha.trim()).filter(Boolean);
  const correcoes: Correcao[] = [];

  for (const linha of linhas) {
    const match = linha.match(/^([a-zà-ú çã ]+?)\s*[:\-]\s*(.+)$/i);
    if (!match) continue;

    const campo = CAMPOS_CORRIGIVEIS[match[1].trim().toLowerCase()];
    if (!campo) continue;

    const valorTexto = match[2].trim();

    if (campo === 'formaPagamento') {
      const forma = normalizarFormaPagamento(valorTexto);
      if (forma) correcoes.push({ campo, valor: forma }); // se não reconhecer, ignora em vez de gravar lixo
      continue;
    }

    if (CAMPOS_NUMERICOS.includes(campo)) {
      const numero = Number(valorTexto.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, ''));
      if (!Number.isNaN(numero)) correcoes.push({ campo, valor: numero });
      continue;
    }

    correcoes.push({ campo, valor: valorTexto });
  }

  return correcoes;
}

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
  console.log(`[conversation] campos extraídos para ${celular}: ${JSON.stringify(campos)}`);

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
  // Sempre tenta resolver uma conta de verdade primeiro — mesmo que já exista um onboarding em
  // andamento (ex: sobra de uma tentativa antiga, ou o cadastro/verificação terminou de acontecer
  // por outro canal enquanto a pessoa ainda respondia as perguntas). Só cai no onboarding quando
  // realmente não existe conta nenhuma pra esse número.
  const sessao = await resolverSessao(celular);

  if (!sessao) {
    const etapaOnboarding = await onboarding.buscarEtapaAtual(celular);
    if (etapaOnboarding) {
      // Nunca grava a senha em texto puro no histórico de mensagens.
      const conteudoHistorico = etapaOnboarding === 'senha' ? '[senha oculta]' : texto;
      await history.salvarMensagem(celular, 'user', conteudoHistorico);
      const resposta = await onboarding.processarResposta(celular, texto);
      await history.salvarMensagem(celular, 'assistant', resposta);
      return resposta;
    }

    await history.salvarMensagem(celular, 'user', texto);
    const resposta = await onboarding.iniciar(celular);
    await history.salvarMensagem(celular, 'assistant', resposta);
    return resposta;
  }

  // Achou conta (login por celular ou sessão local) — se sobrou um onboarding travado de antes,
  // não serve mais pra nada, descarta.
  await onboarding.cancelarSeExistir(celular);

  await history.salvarMensagem(celular, 'user', texto);

  let campos: CamposExtraidos;

  if (sessao.contextoPendente) {
    const { campos: camposAnteriores, perguntando } = sessao.contextoPendente;

    if (perguntando === 'confirmacao') {
      const respostaNormalizada = texto.trim().toLowerCase();

      if (PALAVRAS_AFIRMATIVAS.includes(respostaNormalizada)) {
        campos = { ...camposAnteriores, confirmado: true } as unknown as CamposExtraidos;
      } else if (PALAVRAS_CANCELAMENTO_REGISTRO.includes(respostaNormalizada)) {
        await session.limparContextoPendente(celular);
        const resposta = 'Ok, cancelei esse lançamento. Me manda de novo com os dados certos quando quiser.';
        await history.salvarMensagem(celular, 'assistant', resposta);
        return resposta;
      } else {
        const correcoes = interpretarCorrecoes(texto);
        const camposAtuais = camposAnteriores as unknown as CamposExtraidos;

        if (correcoes.length === 0 && /parcel/i.test(texto) && camposAtuais.intent === 'REGISTRAR_DESPESA') {
          // Compra parcelada = os dois lançamentos: a despesa em si (valor bruto, pra
          // categorização/histórico) MAIS as parcelas como conta a pagar (pro fluxo de caixa) —
          // ver registrarDespesa, que cria as duas coisas quando numeroParcelas vem preenchido.
          const numeroParcelas = Number(texto.match(/(\d+)\s*x\b|(\d+)\s*vezes/i)?.[1] ?? texto.match(/(\d+)\s*x\b|(\d+)\s*vezes/i)?.[2]);

          if (numeroParcelas > 1) {
            campos = { ...camposAtuais, numeroParcelas, confirmado: false };
          } else {
            const aviso = 'Me diga também em quantas vezes ficou (ex: "parcelado em 2x") que eu já registro a despesa e as parcelas como conta a pagar.';
            await history.salvarMensagem(celular, 'assistant', aviso);
            return aviso;
          }
        } else if (correcoes.length === 0 && texto.trim().split(/\s+/).length >= 4) {
          // Não bate com "sim"/"não"/"campo: valor" — mas é uma frase longa, não uma resposta
          // curta. Provavelmente a pessoa está reenviando o pedido do zero (ex: corrigindo o
          // valor direto na frase, "registrar entrada de 160 mil..."), não tentando corrigir um
          // campo específico. Descarta a confirmação pendente e reprocessa como mensagem nova.
          const historico = await history.getRecentHistory(celular);
          const novosCampos = await extrairComFallback(() => extrairIntencao(historico, texto), celular);

          if (novosCampos.intent !== 'NAO_ENTENDI') {
            await session.limparContextoPendente(celular);
            return processarCampos(sessao, celular, novosCampos);
          }

          const dica = 'Não entendi a correção. Responda *sim* pra confirmar assim mesmo, ou me diga o campo e o valor certo (ex: "categoria: combustível"). Pode mandar mais de um por linha.';
          await history.salvarMensagem(celular, 'assistant', dica);
          return dica;
        } else if (correcoes.length === 0) {
          const dica = 'Não entendi a correção. Responda *sim* pra confirmar assim mesmo, ou me diga o campo e o valor certo (ex: "categoria: combustível"). Pode mandar mais de um por linha.';
          await history.salvarMensagem(celular, 'assistant', dica);
          return dica;
        } else {
          // Mantém em modo "não confirmado" — o handler vai reprocessar com os campos corrigidos
          // e mostrar o resumo atualizado de novo, em vez de já gravar no backend.
          campos = { ...camposAtuais };
          for (const correcao of correcoes) {
            (campos as unknown as Record<string, unknown>)[correcao.campo] = correcao.valor;
          }
          campos.confirmado = false;
        }
      }
    } else {
      // A mensagem atual é a resposta à pergunta que o bot fez (ex: "qual fazenda?").
      campos = { ...camposAnteriores, [perguntando]: texto.trim() } as unknown as CamposExtraidos;
    }
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
  const sessao = await resolverSessao(celular);

  if (!sessao) {
    const etapaOnboarding = await onboarding.buscarEtapaAtual(celular);
    if (etapaOnboarding) {
      return 'Ainda estou te ajudando a criar sua conta — responde por texto, por favor. 🙂';
    }

    await history.salvarMensagem(celular, 'user', '[foto enviada]');
    const resposta = await onboarding.iniciar(celular);
    await history.salvarMensagem(celular, 'assistant', resposta);
    return resposta;
  }

  await onboarding.cancelarSeExistir(celular);

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
