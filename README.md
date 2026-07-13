# bot-safraplan

Bot de WhatsApp com IA para o SafraPlan. Fluxo:

```
WhatsApp → WAHA → Webhook (este serviço) → IA (OpenAI/Claude) → backend-safraplan → Resposta → WhatsApp
```

O produtor manda mensagem em linguagem natural ("gastei 500 com combustível hoje", "vendi 200 sacas de soja a 148", "quanto devo até o fim do mês?"), a IA extrai a intenção, o bot resolve fazenda/categoria/produto e chama a API do [backend-safraplan](../backend-safraplan) para registrar ou consultar os dados, e responde no próprio WhatsApp.

## Como o bot identifica quem está falando

Não existe login/senha por WhatsApp. O número de celular *é* a identidade: quando alguém manda a primeira mensagem, o bot chama `POST /auth/whatsapp` no backend-safraplan passando o celular; se existir um cliente cadastrado no SafraPlan com aquele número, o backend devolve um token e o bot guarda essa sessão. Se não existir, o bot pede pra pessoa se cadastrar no app primeiro. Essa rota é protegida por um segredo compartilhado (`WHATSAPP_BOT_SECRET`, header `x-integration-secret`) — só o bot pode chamá-la, nunca é exposta a usuários finais.

## Estrutura

```
src/
├── app.ts                     # entrypoint (Express)
├── database/
│   ├── data-source.ts         # DataSource do TypeORM (schema `chat`, migrations no boot)
│   ├── entities/               # SessaoWhatsapp, Mensagem
│   └── migrations/             # migrations do TypeORM (schema `chat`)
├── routes/
│   ├── webhook.ts              # POST /webhook/whatsapp — recebe eventos da WAHA/Meta
│   └── chat.ts                 # POST /chat/mensagem, /chat/insights — acesso direto (sem WhatsApp)
├── middlewares/
│   └── autenticarCliente.ts   # exige Authorization: Bearer <token> nas rotas de /chat
├── services/
│   ├── waha.ts                 # envia mensagens de volta via WAHA
│   ├── ai.ts                   # OpenAI/Claude/NVIDIA com tool-calling -> intenção estruturada / insights
│   ├── backendClient.ts        # chamadas HTTP para o backend-safraplan
│   ├── session.ts              # celular <-> cliente/token do backend-safraplan (via TypeORM)
│   ├── history.ts              # histórico de mensagens (contexto pra IA, via TypeORM)
│   ├── insights.ts             # agrega gastos por categoria e gera insights via IA
│   └── conversation.ts         # orquestrador: sessão + histórico + IA + handlers
└── intents/
    ├── resolvers.ts            # resolve nomes em texto livre -> slugs (fazenda/categoria/produto)
    └── handlers.ts              # um handler por intenção (despesa, conta, venda, resumo, preços)
```

## Chat direto (sem WhatsApp)

Além do webhook, o bot expõe o mesmo motor de conversa por HTTP puro — útil para testar a IA (incluindo NVIDIA) sem precisar mandar mensagem de WhatsApp de verdade. As duas rotas exigem `Authorization: Bearer <token>` com o mesmo JWT que o cliente já usa no restante do SafraPlan.

Diferente do fluxo real de WhatsApp (sem token, precisa autenticar por celular no backend-safraplan), aqui o chamador já chega autenticado — a sessão local é criada/atualizada direto a partir do próprio token da requisição (clienteId + slug), sem chamada nenhuma ao backend-safraplan. O `celular` no corpo é **opcional**: se vier, é usado como identificador da sessão/histórico (e confere que pertence a esse mesmo cliente, respondendo `403` se não bater); se não vier, o bot busca a sessão já existente pelo `clienteId` do próprio token — só funciona se esse cliente já tiver mandado mensagem (com celular) pelo menos uma vez antes.

- `POST /chat/mensagem` — body `{ "celular": "5511999999999", "mensagem": "gastei 500 reais com combustível hoje" }` (celular opcional). Roda exatamente o mesmo fluxo do WhatsApp (histórico, extração de intenção pela IA, registro no backend-safraplan) e devolve `{ "resposta": "..." }`.
- `POST /chat/insights` — body `{ "celular": "5511999999999" }` (celular opcional). Calcula totais de gastos por categoria (mês atual vs anterior) e contas vencendo nos próximos 7 dias a partir do backend-safraplan, e pede pra IA transformar esses números em frases curtas — devolve `{ "insights": ["..."], "resumo": {...} }`.

## Intenções suportadas

| Intenção | Exemplo de mensagem | O que faz |
|---|---|---|
| `REGISTRAR_DESPESA` | "gastei 500 com combustível hoje" | `POST /despesas` |
| `REGISTRAR_CONTA_PAGAR` | "tenho uma conta de 3000 pra pagar dia 15" | `POST /contas-pagar` |
| `REGISTRAR_CONTA_RECEBER` | "vou receber 8000 do frigorífico dia 20" | `POST /contas-receber` |
| `REGISTRAR_VENDA` | "vendi 200 sacas de soja a 148 reais" | `POST /vendas` |
| `CONSULTAR_RESUMO` | "qual meu resumo financeiro" | `GET /dashboard/resumo` |
| `CONSULTAR_CONTAS_PAGAR` | "o que tá vencendo" | `GET /contas-pagar?status=PENDENTE` |
| `CONSULTAR_PRECOS_MERCADO` | "quanto tá a saca da soja" | `GET /fazendas/:slug/precos-mercado` |
| `SAUDACAO` / `AJUDA` / `NAO_ENTENDI` | "oi", "o que você faz" | resposta direta da IA, sem chamar o backend |

Quando falta uma informação obrigatória (ex: o cliente tem mais de uma fazenda e não disse qual), o bot pergunta e guarda o contexto pendente em `chat.sessoes_whatsapp.contexto_pendente` — a próxima mensagem completa o registro, sem precisar repetir tudo.

## Rodando localmente

Pré-requisitos: Docker e Docker Compose.

1. Copie o `.env` de exemplo e preencha as chaves:
   ```bash
   cp .env.example .env
   ```
   Você vai precisar de: `OPENAI_API_KEY` (ou `ANTHROPIC_API_KEY`, dependendo de `AI_PROVIDER`), `WAHA_API_KEY` (invente uma chave forte), `WEBHOOK_SECRET` (invente outra), `WHATSAPP_BOT_SECRET` (precisa ser **idêntico** ao configurado no `backend-safraplan`), e `BACKEND_API_URL` apontando pro backend (local ou já publicado no Render).

2. Suba tudo:
   ```bash
   docker-compose up
   ```

3. Escaneie o QR code que aparece no log do container `waha` com o WhatsApp que vai ser o número do bot (Configurações → Aparelhos conectados → Conectar um aparelho).

4. Mande uma mensagem de teste pro número conectado, de um celular que já seja `celular` de algum cliente cadastrado no `backend-safraplan`.

## Deploy no Render

O `render.yaml` na raiz já descreve os 3 serviços (WAHA, bot, Postgres) como [Blueprint](https://render.com/docs/blueprint-spec). Passos:

1. No backend-safraplan, configure a variável de ambiente `WHATSAPP_BOT_SECRET` (mesmo valor que você vai usar aqui) e garanta que os módulos de Despesas/Contas/Vendas/Dashboard/Auth por celular estejam deployados.
2. No Render, crie um novo **Blueprint** apontando para este repositório — ele vai propor os 3 serviços do `render.yaml`.
3. **Importante sobre a WAHA**: ela precisa manter a sessão do WhatsApp entre deploys, então o serviço usa um *disk* persistente (`/app/.sessions`) — isso exige um plano pago (o free tier do Render não suporta disks). Sem isso, você teria que escanear o QR code de novo a cada deploy.
4. Preencha manualmente no dashboard do Render as variáveis marcadas com `sync: false` no `render.yaml`: `WAHA_API_KEY` (mesmo valor nos dois serviços), `WHATSAPP_HOOK_URL` (aponte pra URL pública do serviço `bot-safraplan` + `/webhook/whatsapp?token=<WEBHOOK_SECRET>`), `WHATSAPP_BOT_SECRET`, `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`.
5. Depois do primeiro deploy, abra os logs do serviço `waha-safraplan` para pegar o QR code (ou use a rota de screenshot da própria WAHA — veja a documentação oficial) e escaneie com o número que vai ser o bot.
6. Confirme testando o health check: `GET https://<bot>.onrender.com/health`.

### Sobre a WAHA em produção

A [WAHA](https://waha.devlike.pro) é open-source (engine `NOWEB` gratuito) e roda como um único container. Nomes de env vars e caminho do volume de sessão mudam entre versões — confira a documentação oficial da versão que for usar antes do deploy final; o `docker-compose.yml`/`render.yaml` aqui usam os nomes mais comuns (`WAHA_API_KEY`, `WHATSAPP_HOOK_URL`, `WHATSAPP_HOOK_EVENTS`, `/app/.sessions`), mas vale validar.

Se preferir usar a Evolution API no lugar da WAHA, troque só `src/services/waha.js` (payload de envio/recebimento é diferente) e a seção de infraestrutura do `render.yaml`/`docker-compose.yml` — o resto do bot (IA, backendClient, handlers) não muda.

## Variáveis de ambiente

Veja `.env.example`. Resumo do que cada uma faz:

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Postgres próprio do bot (sessões + histórico, no schema `chat`, gerenciado via TypeORM) |
| `WAHA_URL` / `WAHA_API_KEY` / `WAHA_SESSION` | Como o bot fala com a WAHA para enviar mensagens |
| `WEBHOOK_SECRET` | Segredo na query string do webhook, pra evitar chamadas de terceiros |
| `BACKEND_API_URL` | Base URL da API do backend-safraplan |
| `WHATSAPP_BOT_SECRET` | Segredo compartilhado com o backend-safraplan para autenticar por celular |
| `AI_PROVIDER` | `openai` ou `anthropic` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Chaves da IA (só precisa da que estiver em uso) |

## Limitações conhecidas / próximos passos

- A IA resolve categoria por aproximação de texto; se não encontrar nenhuma parecida, cai em "Outros".
- Não há reautenticação por link mágico se o cliente trocar de número — nesse caso é preciso atualizar o `celular` no cadastro do SafraPlan.
- `/dashboard/fluxo-caixa` e `/dashboard/safra/:slug` (do backend-safraplan) ainda não têm intenção mapeada aqui — dá pra adicionar um novo caso em `src/intents/handlers.js` quando fizer sentido.
- Sem retry/fila para envio de mensagem — se a WAHA estiver fora do ar no momento da resposta, a mensagem é perdida (log de erro fica no console).
