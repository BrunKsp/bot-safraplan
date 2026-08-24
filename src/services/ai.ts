// Camada de IA: transforma a mensagem em texto livre do produtor em uma intenção estruturada.
// Usa OpenAI, Anthropic, NVIDIA NIM ou OpenRouter dependendo de AI_PROVIDER (mesmo padrão do chat-bot do Instagram).
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
  // Preenchido pelo orquestrador (não pela IA) quando a mensagem era uma foto e o upload para o
  // R2 deu certo — não faz parte do schema de tool-calling.
  anexoUrl?: string;
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

// Loga duração + retorno bruto de cada chamada a um provedor compatível com a API da OpenAI
// (NVIDIA NIM, OpenRouter) — útil pra diagnosticar sem precisar reproduzir o caso (o
// resumo/mensagem em si não é logado, só a resposta do modelo).
function logChamadaCompativelOpenAI(label: string, inicioMs: number, response: OpenAI.Chat.Completions.ChatCompletion): void {
  const duracaoMs = Date.now() - inicioMs;
  const escolha = response.choices[0];
  console.log(
    `[ia:${label}] duracaoMs=${duracaoMs} model=${response.model} finish_reason=${escolha?.finish_reason} usage=${JSON.stringify(response.usage)} message=${JSON.stringify(escolha?.message)}`
  );
}

async function gerarInsightsComNvidia(resumo: ResumoFinanceiro): Promise<Insights> {
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });

  const inicioMs = Date.now();
  const response = await client.chat.completions.create({
    model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
    messages: [
      { role: 'system', content: buildInsightsSystemPrompt() + '\n\nReasoning strength: low' },
      { role: 'user', content: JSON.stringify(resumo) },
    ],
    tools: [{ type: 'function', function: { name: 'gerar_insights', description: 'Registra os insights financeiros gerados.', parameters: INSIGHTS_PARAMETROS } }],
    tool_choice: { type: 'function', function: { name: 'gerar_insights' } },
  });
  logChamadaCompativelOpenAI('gerarInsights', inicioMs, response);

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall || toolCall.type !== 'function') return { insights: [] };
  return JSON.parse(toolCall.function.arguments);
}

async function gerarInsightsComOpenRouter(resumo: ResumoFinanceiro): Promise<Insights> {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  const inicioMs = Date.now();
  const response = await client.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    messages: [
      { role: 'system', content: buildInsightsSystemPrompt() },
      { role: 'user', content: JSON.stringify(resumo) },
    ],
    tools: [{ type: 'function', function: { name: 'gerar_insights', description: 'Registra os insights financeiros gerados.', parameters: INSIGHTS_PARAMETROS } }],
    tool_choice: { type: 'function', function: { name: 'gerar_insights' } },
  });
  logChamadaCompativelOpenAI('gerarInsights:openrouter', inicioMs, response);

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

  if (provider === 'openrouter') {
    return gerarInsightsComOpenRouter(resumo);
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

async function extrairComNvidia(historico: MensagemHistorico[], mensagem: string): Promise<CamposExtraidos> {
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });

  // Nem todo modelo do NIM honra "tool_choice" de forma consistente (alguns respondem em texto
  // solto mesmo forçado a chamar a ferramenta) — a instrução extra abaixo é uma rede de segurança
  // pro caso disso acontecer, pra ainda dar pra extrair algo em vez de cair direto em NAO_ENTENDI.
  const instrucaoFallback = '\n\nSe por qualquer motivo você não conseguir chamar a ferramenta "interpretar_mensagem", responda com o mesmo JSON que passaria pra ela, e nada mais (sem texto explicativo, sem markdown).';

  // Modelos "reasoning" do NIM (ex: Muse Glimmer) controlam o quanto pensam antes de responder
  // via uma linha "Reasoning strength: <nível>" no system prompt, não um parâmetro separado da
  // API — "low" é suficiente pra uma extração estruturada simples e evita raciocínio longo (que
  // em teste chegou a levar mais de 1 minuto numa única chamada).
  const instrucaoReasoning = '\n\nReasoning strength: low';

  const inicioMs = Date.now();
  const response = await client.chat.completions.create({
    model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
    messages: [
      { role: 'system', content: buildSystemPrompt(hojeISO()) + instrucaoFallback + instrucaoReasoning },
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
  logChamadaCompativelOpenAI('extrairIntencao', inicioMs, response);

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (toolCall && toolCall.type === 'function') {
    return JSON.parse(toolCall.function.arguments);
  }

  const texto = response.choices[0].message.content;
  return texto ? extrairJsonDaResposta(texto) : NAO_ENTENDI_FALLBACK;
}

async function extrairComOpenRouter(historico: MensagemHistorico[], mensagem: string): Promise<CamposExtraidos> {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  // Nem todo modelo grátis do roteador honra "tool_choice" de forma consistente — mesma rede de
  // segurança usada na NVIDIA: se não vier tool_call, tenta extrair um JSON do texto puro.
  const instrucaoFallback = '\n\nSe por qualquer motivo você não conseguir chamar a ferramenta "interpretar_mensagem", responda com o mesmo JSON que passaria pra ela, e nada mais (sem texto explicativo, sem markdown).';

  const inicioMs = Date.now();
  const response = await client.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
    messages: [
      { role: 'system', content: buildSystemPrompt(hojeISO()) + instrucaoFallback },
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
  logChamadaCompativelOpenAI('extrairIntencao:openrouter', inicioMs, response);

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (toolCall && toolCall.type === 'function') {
    return JSON.parse(toolCall.function.arguments);
  }

  const texto = response.choices[0].message.content;
  return texto ? extrairJsonDaResposta(texto) : NAO_ENTENDI_FALLBACK;
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

  if (provider === 'openrouter') {
    return extrairComOpenRouter(historico, mensagem);
  }

  return extrairComOpenAI(historico, mensagem);
}

// ─── Classificação de imagem (foto de nota fiscal, recibo, cupom, comprovante PIX etc.) ───────

function buildImageSystemPrompt(hoje: string): string {
  return `Você é o SafraBot, assistente de WhatsApp do SafraPlan — sistema de gestão financeira para produtores rurais.

O produtor te enviou uma FOTO em vez de texto. A imagem costuma ser uma nota fiscal, recibo, cupom fiscal ou comprovante de pagamento (ex: PIX, boleto pago). Examine a imagem e extraia os campos estruturados, do mesmo jeito que faria para uma mensagem de texto equivalente.

A data de hoje é ${hoje} (formato YYYY-MM-DD). Se a imagem tiver uma data visível, use-a; senão use a data de hoje.

Na grande maioria dos casos a intenção correta é REGISTRAR_DESPESA (valor total, descrição do que foi comprado, categoria — ex: combustível, insumos, manutenção — e forma de pagamento se visível no comprovante).

IMPORTANTE sobre o campo "valor": use SEMPRE o valor total IMPRESSO no documento (linha "VALOR TOTAL", "TOTAL A PAGAR" ou equivalente). Anotações escritas à mão, números circulados/rabiscados ou rasurados no verso ou nas bordas do cupom NÃO são o valor da despesa — ignore-os completamente, mesmo que pareçam mais em destaque que o total impresso.

IMPORTANTE sobre o campo "fazenda": é a propriedade rural do PRODUTOR — essa informação NUNCA está impressa num cupom fiscal, recibo ou comprovante de pagamento, então NUNCA preencha "fazenda" a partir de texto impresso na imagem. Isso inclui, sem exceção: nome do estabelecimento (ex: "Posto Extremoz"), endereço, CNPJ, razão social, nome do banco/adquirente/bandeira do cartão, e qualquer outro texto impresso — mesmo que pareça um nome próprio ou lembre um termo agrícola. NUNCA use "SafraPlan", "SafraBot" ou qualquer variação do nome do sistema/assistente (mencionados acima neste prompt) como valor de "fazenda" — não existe relação entre o nome do produto e a propriedade do produtor. Na dúvida, deixe "fazenda" de fora — o sistema pergunta ao produtor depois, se precisar. Só preencha "fazenda" se o produtor tiver escrito à mão, à parte, algo como "fazenda: X" ou anotado claramente o nome da propriedade. O nome do estabelecimento pode entrar em "descricao" (ex: "Abastecimento no Posto Extremoz"), nunca em "fazenda".

Se a imagem não for legível ou não parecer um documento financeiro, use intent NAO_ENTENDI e preencha "resposta" pedindo para o produtor descrever a despesa em texto ou mandar uma foto mais nítida.`;
}

async function classificarImagemComOpenAI(base64: string, mimeType: string): Promise<CamposExtraidos> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: buildImageSystemPrompt(hojeISO()) },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analise esta imagem e extraia os dados financeiros.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'interpretar_mensagem',
          description: 'Registra a intenção estruturada extraída da imagem enviada pelo produtor.',
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

async function classificarImagemComClaude(base64: string, mimeType: string): Promise<CamposExtraidos> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: buildImageSystemPrompt(hojeISO()),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType as any, data: base64 } },
          { type: 'text', text: 'Analise esta imagem e extraia os dados financeiros.' },
        ],
      },
    ],
    tools: [
      {
        name: 'interpretar_mensagem',
        description: 'Registra a intenção estruturada extraída da imagem enviada pelo produtor.',
        input_schema: PARAMETROS as any,
      },
    ],
    tool_choice: { type: 'tool', name: 'interpretar_mensagem' },
  });

  const toolUse = response.content.find((bloco) => bloco.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') return NAO_ENTENDI_FALLBACK;

  return toolUse.input as CamposExtraidos;
}

// Modelos de tool-calling do NIM nem sempre suportam visão junto com function-calling — em vez de
// arriscar, pedimos o JSON direto no texto da resposta e extraímos o primeiro bloco {...} dela.
function buildImageJsonInstructions(): string {
  return `Sua resposta inteira deve ser SOMENTE o objeto JSON abaixo preenchido — nenhuma outra palavra antes ou depois, nenhuma explicação, nenhum markdown/crase, nenhuma lista com "*". A primeira letra da sua resposta precisa ser "{" e a última precisa ser "}". O campo "data" precisa estar EXATAMENTE no formato YYYY-MM-DD (ex: 2026-07-25) — nunca DD/MM/YYYY.

Formato exato:
{"intent": "REGISTRAR_DESPESA" | "NAO_ENTENDI", "valor": number opcional, "descricao": string opcional, "categoria": string opcional, "fazenda": string opcional, "data": "YYYY-MM-DD" opcional, "formaPagamento": "DINHEIRO"|"PIX"|"CARTAO"|"BOLETO"|"FINANCIAMENTO"|"OUTRO" opcional, "resposta": string opcional (obrigatório se intent for NAO_ENTENDI)}`;
}

// O modelo às vezes manda a data em DD/MM/YYYY apesar da instrução — normaliza em vez de
// confiar 100% no formato pedido, pra não quebrar a validação do backend-safraplan.
function normalizarData(data?: string): string | undefined {
  if (!data) return undefined;

  const isoMatch = data.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const brMatch = data.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (brMatch) {
    const [, dia, mes, ano] = brMatch;
    return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
  }

  return undefined;
}

function extrairJsonDaResposta(texto: string): CamposExtraidos {
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return NAO_ENTENDI_FALLBACK;

  try {
    const campos = JSON.parse(match[0]);
    if (campos.data) campos.data = normalizarData(campos.data);
    return campos;
  } catch {
    return NAO_ENTENDI_FALLBACK;
  }
}

async function classificarImagemComNvidia(base64: string, mimeType: string): Promise<CamposExtraidos> {
  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });

  const inicioMs = Date.now();
  const response = await client.chat.completions.create({
    model: process.env.NVIDIA_VISION_MODEL || 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1',
    max_tokens: 1000,
    messages: [
      { role: 'system', content: `${buildImageSystemPrompt(hojeISO())}\n\n${buildImageJsonInstructions()}` },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analise esta imagem e extraia os dados financeiros.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  });
  logChamadaCompativelOpenAI('classificarImagem', inicioMs, response);

  const texto = response.choices[0]?.message?.content?.trim();
  if (!texto) return NAO_ENTENDI_FALLBACK;

  return extrairJsonDaResposta(texto);
}

async function classificarImagemComOpenRouter(base64: string, mimeType: string): Promise<CamposExtraidos> {
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1',
  });

  const inicioMs = Date.now();
  const response = await client.chat.completions.create({
    model: process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || 'openrouter/free',
    max_tokens: 1000,
    messages: [
      { role: 'system', content: `${buildImageSystemPrompt(hojeISO())}\n\n${buildImageJsonInstructions()}` },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analise esta imagem e extraia os dados financeiros.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  });
  logChamadaCompativelOpenAI('classificarImagem:openrouter', inicioMs, response);

  const texto = response.choices[0]?.message?.content?.trim();
  if (!texto) return NAO_ENTENDI_FALLBACK;

  return extrairJsonDaResposta(texto);
}

const IMAGEM_SEM_PROVEDOR_VISAO: CamposExtraidos = {
  intent: 'NAO_ENTENDI',
  resposta: 'Ainda não consigo analisar imagens com a configuração atual. Pode descrever a despesa em texto?',
};

// Classifica uma imagem (base64, sem o prefixo "data:...;base64,") recebida por WhatsApp.
// Quando AI_PROVIDER=nvidia, usa um modelo de visão do NIM (NVIDIA_VISION_MODEL, mesma
// NVIDIA_API_KEY já configurada para texto) — não depende de OpenAI/Anthropic.
export async function classificarImagem(base64: string, mimeType: string): Promise<CamposExtraidos> {
  const campos = await classificarImagemComProvider(base64, mimeType);
  if (campos.data) campos.data = normalizarData(campos.data);
  return campos;
}

async function classificarImagemComProvider(base64: string, mimeType: string): Promise<CamposExtraidos> {
  const provider = process.env.AI_PROVIDER || 'openai';

  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) return IMAGEM_SEM_PROVEDOR_VISAO;
    return classificarImagemComClaude(base64, mimeType);
  }

  if (provider === 'nvidia') {
    if (!process.env.NVIDIA_API_KEY) return IMAGEM_SEM_PROVEDOR_VISAO;
    return classificarImagemComNvidia(base64, mimeType);
  }

  if (provider === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY) return IMAGEM_SEM_PROVEDOR_VISAO;
    return classificarImagemComOpenRouter(base64, mimeType);
  }

  if (!process.env.OPENAI_API_KEY) return IMAGEM_SEM_PROVEDOR_VISAO;
  return classificarImagemComOpenAI(base64, mimeType);
}
