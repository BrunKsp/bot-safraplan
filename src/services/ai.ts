// Camada de IA: transforma a mensagem em texto livre do produtor em uma intenção estruturada.
// Usa OpenAI, Anthropic ou NVIDIA NIM dependendo de AI_PROVIDER (mesmo padrão do chat-bot do Instagram).
//
// A IA sempre "chama uma ferramenta" (function/tool calling) em vez de responder em texto livre —
// isso garante que a saída seja sempre um JSON previsível que o restante do bot sabe processar.

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { MensagemHistorico } from './history';

export type Intent =
  | 'REGISTRAR_DESPESA'
  | 'REGISTRAR_CONTA_PAGAR'
  | 'REGISTRAR_CONTA_RECEBER'
  | 'REGISTRAR_VENDA'
  | 'CONSULTAR_RESUMO'
  | 'CONSULTAR_CONTAS_PAGAR'
  | 'CONSULTAR_PRECOS_MERCADO'
  | 'SAUDACAO'
  | 'AJUDA'
  | 'NAO_ENTENDI';

export type FormaPagamento = 'DINHEIRO' | 'PIX' | 'CARTAO' | 'BOLETO' | 'FINANCIAMENTO' | 'OUTRO';
export type UnidadeMedida = 'KG' | 'SACA' | 'TON' | 'ARROBA' | 'L' | 'UNIDADE';

export interface CamposExtraidos {
  intent: Intent;
  valor?: number;
  descricao?: string;
  categoria?: string;
  fazenda?: string;
  safra?: string;
  data?: string;
  dataVencimento?: string;
  formaPagamento?: FormaPagamento;
  fornecedor?: string;
  comprador?: string;
  produto?: string;
  quantidade?: number;
  unidadeMedida?: UnidadeMedida;
  gerarContaReceber?: boolean;
  resposta?: string;
}

const INTENTS: Intent[] = [
  'REGISTRAR_DESPESA',
  'REGISTRAR_CONTA_PAGAR',
  'REGISTRAR_CONTA_RECEBER',
  'REGISTRAR_VENDA',
  'CONSULTAR_RESUMO',
  'CONSULTAR_CONTAS_PAGAR',
  'CONSULTAR_PRECOS_MERCADO',
  'SAUDACAO',
  'AJUDA',
  'NAO_ENTENDI',
];

const FORMAS_PAGAMENTO: FormaPagamento[] = ['DINHEIRO', 'PIX', 'CARTAO', 'BOLETO', 'FINANCIAMENTO', 'OUTRO'];
const UNIDADES: UnidadeMedida[] = ['KG', 'SACA', 'TON', 'ARROBA', 'L', 'UNIDADE'];

const PARAMETROS = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENTS, description: 'A intenção principal da mensagem do produtor.' },
    valor: { type: 'number', description: 'Valor em reais mencionado (despesa, conta, preço unitário de venda).' },
    descricao: { type: 'string', description: 'Descrição curta do que foi gasto/vendido/a pagar/a receber.' },
    categoria: { type: 'string', description: 'Categoria mencionada em texto livre (ex: combustível, fertilizante, mão de obra).' },
    fazenda: { type: 'string', description: 'Nome da fazenda mencionada, se houver.' },
    safra: { type: 'string', description: 'Safra/cultura e ano mencionados, se houver (ex: "soja 2025").' },
    data: { type: 'string', description: 'Data do evento no formato YYYY-MM-DD, resolvida a partir de expressões como "hoje", "ontem". Se não mencionada, use a data de hoje informada no prompt.' },
    dataVencimento: { type: 'string', description: 'Data de vencimento no formato YYYY-MM-DD, para contas a pagar/receber.' },
    formaPagamento: { type: 'string', enum: FORMAS_PAGAMENTO, description: 'Forma de pagamento mencionada.' },
    fornecedor: { type: 'string', description: 'Fornecedor mencionado (contas a pagar).' },
    comprador: { type: 'string', description: 'Comprador mencionado (vendas, contas a receber).' },
    produto: { type: 'string', description: 'Produto vendido, em texto livre (ex: soja, milho, boi gordo).' },
    quantidade: { type: 'number', description: 'Quantidade vendida.' },
    unidadeMedida: { type: 'string', enum: UNIDADES, description: 'Unidade de medida da quantidade/produto.' },
    gerarContaReceber: { type: 'boolean', description: 'true se o produtor deu a entender que já recebeu o pagamento da venda.' },
    resposta: { type: 'string', description: 'Resposta curta e amigável em português para o caso de SAUDACAO, AJUDA ou NAO_ENTENDI. Ignorado nos outros intents.' },
  },
  required: ['intent'],
};

function buildSystemPrompt(hoje: string): string {
  return `Você é o SafraBot, assistente de WhatsApp do SafraPlan — sistema de gestão financeira para produtores rurais.

Sua única função é interpretar a mensagem do produtor e chamar a ferramenta "interpretar_mensagem" com os campos extraídos. Nunca responda em texto livre fora da ferramenta.

A data de hoje é ${hoje} (formato YYYY-MM-DD). Resolva expressões relativas de data ("hoje", "ontem", "dia 15") com base nela.

Exemplos de intenção:
- "gastei 500 reais com combustível hoje" -> REGISTRAR_DESPESA (valor=500, categoria=combustível, data=hoje)
- "tenho uma conta de 3000 pra pagar dia 15" -> REGISTRAR_CONTA_PAGAR (valor=3000, dataVencimento=YYYY-MM-15)
- "vendi 200 sacas de soja a 148 reais" -> REGISTRAR_VENDA (produto=soja, quantidade=200, unidadeMedida=SACA, valor=148)
- "quanto devo até o fim do mês" / "qual meu resumo" -> CONSULTAR_RESUMO
- "o que tá vencendo" / "contas a pagar" -> CONSULTAR_CONTAS_PAGAR
- "quanto tá a saca da soja" / "preço do milho hoje" -> CONSULTAR_PRECOS_MERCADO
- "oi" / "bom dia" -> SAUDACAO (preencha "resposta" com uma saudação curta se apresentando como SafraBot)
- pedido de ajuda / "o que você faz" -> AJUDA (preencha "resposta" explicando em 2-3 frases o que dá pra fazer: registrar despesa, conta a pagar, conta a receber, venda, e consultar resumo/preços)
- mensagem incompreensível -> NAO_ENTENDI (preencha "resposta" pedindo para reformular, com um exemplo)

Sempre que faltar informação para registrar algo (ex: valor não mencionado), ainda assim classifique a intenção corretamente e deixe os campos que faltam de fora — quem trata os campos faltando é o backend do bot, não você.`;
}

function hojeISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export type ResumoFinanceiro = object;

export interface Insights {
  insights: string[];
}

const INSIGHTS_PARAMETROS = {
  type: 'object',
  properties: {
    insights: {
      type: 'array',
      items: { type: 'string' },
      description: '3 a 4 frases curtas em português, cada uma destacando um insight financeiro distinto.',
    },
  },
  required: ['insights'],
};

function buildInsightsSystemPrompt(): string {
  return `Você é o SafraBot, assistente financeiro do SafraPlan.

Você vai receber um objeto JSON com números já calculados sobre os gastos do produtor (totais por categoria no mês atual e no mês anterior, variação percentual, participação percentual, e quantidade de contas vencendo nos próximos 7 dias).

Sua única função é chamar a ferramenta "gerar_insights" com 3 a 4 frases curtas em português, no mesmo tom de um card de insights de um app financeiro (ex: "Seus gastos com Combustível caíram 9% em relação ao mês anterior."). Use exatamente os números fornecidos — nunca invente ou arredonde de forma diferente do que já vier calculado. Não inclua frases sobre dados que não estejam no JSON.`;
}

async function gerarInsightsComOpenAI(resumo: ResumoFinanceiro): Promise<Insights> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildInsightsSystemPrompt() },
      { role: 'user', content: JSON.stringify(resumo) },
    ],
    tools: [{ type: 'function', function: { name: 'gerar_insights', description: 'Registra os insights financeiros gerados.', parameters: INSIGHTS_PARAMETROS } }],
    tool_choice: { type: 'function', function: { name: 'gerar_insights' } },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') return { insights: [] };
  return JSON.parse(toolCall.function.arguments);
}

async function gerarInsightsComNvidia(resumo: ResumoFinanceiro): Promise<Insights> {
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });

  const response = await client.chat.completions.create({
    model: process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-pro',
    messages: [
      { role: 'system', content: buildInsightsSystemPrompt() },
      { role: 'user', content: JSON.stringify(resumo) },
    ],
    tools: [{ type: 'function', function: { name: 'gerar_insights', description: 'Registra os insights financeiros gerados.', parameters: INSIGHTS_PARAMETROS } }],
    tool_choice: { type: 'function', function: { name: 'gerar_insights' } },
    // @ts-expect-error -- extensão específica da NVIDIA NIM, fora do SDK oficial da OpenAI.
    chat_template_kwargs: { thinking: false },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') return { insights: [] };
  return JSON.parse(toolCall.function.arguments);
}

async function gerarInsightsComClaude(resumo: ResumoFinanceiro): Promise<Insights> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: buildInsightsSystemPrompt(),
    messages: [{ role: 'user', content: JSON.stringify(resumo) }],
    tools: [{ name: 'gerar_insights', description: 'Registra os insights financeiros gerados.', input_schema: INSIGHTS_PARAMETROS as any }],
    tool_choice: { type: 'tool', name: 'gerar_insights' },
  });

  const toolUse = response.content.find((bloco) => bloco.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') return { insights: [] };
  return toolUse.input as Insights;
}

// Transforma números já calculados (totais por categoria, variação mês a mês, contas
// vencendo) em frases curtas de insight, usando o provedor configurado em AI_PROVIDER.
export async function gerarInsights(resumo: ResumoFinanceiro): Promise<Insights> {
  const provider = process.env.AI_PROVIDER || 'openai';

  if (provider === 'anthropic') {
    return gerarInsightsComClaude(resumo);
  }

  if (provider === 'nvidia') {
    return gerarInsightsComNvidia(resumo);
  }

  return gerarInsightsComOpenAI(resumo);
}

const NAO_ENTENDI_FALLBACK: CamposExtraidos = { intent: 'NAO_ENTENDI', resposta: 'Não consegui entender, pode reformular?' };

async function extrairComOpenAI(historico: MensagemHistorico[], mensagem: string): Promise<CamposExtraidos> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildSystemPrompt(hojeISO()) },
      ...historico,
      { role: 'user', content: mensagem },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'interpretar_mensagem',
          description: 'Registra a intenção estruturada extraída da mensagem do produtor.',
          parameters: PARAMETROS,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'interpretar_mensagem' } },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') return NAO_ENTENDI_FALLBACK;

  return JSON.parse(toolCall.function.arguments);
}

// Modelos NVIDIA NIM (ex: DeepSeek) expõem "chat_template_kwargs.thinking" para desligar o
// modo de raciocínio — queremos isso desligado aqui pra ter tool-calling determinístico e rápido.
async function extrairComNvidia(historico: MensagemHistorico[], mensagem: string): Promise<CamposExtraidos> {
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });

  const response = await client.chat.completions.create({
    model: process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4-pro',
    messages: [
      { role: 'system', content: buildSystemPrompt(hojeISO()) },
      ...historico,
      { role: 'user', content: mensagem },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'interpretar_mensagem',
          description: 'Registra a intenção estruturada extraída da mensagem do produtor.',
          parameters: PARAMETROS,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'interpretar_mensagem' } },
    // @ts-expect-error -- extensão específica da NVIDIA NIM, fora do SDK oficial da OpenAI.
    chat_template_kwargs: { thinking: false },
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') return NAO_ENTENDI_FALLBACK;

  return JSON.parse(toolCall.function.arguments);
}

async function extrairComClaude(historico: MensagemHistorico[], mensagem: string): Promise<CamposExtraidos> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: buildSystemPrompt(hojeISO()),
    messages: [...historico, { role: 'user', content: mensagem }],
    tools: [
      {
        name: 'interpretar_mensagem',
        description: 'Registra a intenção estruturada extraída da mensagem do produtor.',
        input_schema: PARAMETROS as any,
      },
    ],
    tool_choice: { type: 'tool', name: 'interpretar_mensagem' },
  });

  const toolUse = response.content.find((bloco) => bloco.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') return NAO_ENTENDI_FALLBACK;

  return toolUse.input as CamposExtraidos;
}

// Extrai a intenção estruturada da mensagem, usando o provedor configurado em AI_PROVIDER.
// `historico` é um array de { role: 'user' | 'assistant', content: string } com as últimas mensagens da conversa.
export async function extrairIntencao(historico: MensagemHistorico[], mensagem: string): Promise<CamposExtraidos> {
  const provider = process.env.AI_PROVIDER || 'openai';

  if (provider === 'anthropic') {
    return extrairComClaude(historico, mensagem);
  }

  if (provider === 'nvidia') {
    return extrairComNvidia(historico, mensagem);
  }

  return extrairComOpenAI(historico, mensagem);
}
