# Faro

Ferramenta de prospecção B2B: acha empresas por nicho + cidade, **audita a presença digital** de cada uma, gera a **mensagem de abordagem** personalizada e devolve o link pronto do WhatsApp. **Front-end e back-end no mesmo projeto** — o Express serve a página e a API.

## Rodar

```bash
npm install
cp .env.example .env     # preencha as chaves
npm start                # abre em http://localhost:3000
```

Abriu em `http://localhost:3000`? O topo mostra **"Conectado à API"** (verde) = dados reais.
Sem back-end / sem chaves, a página abre em **"Modo demonstração"** com empresas de exemplo — o fluxo todo funciona pra você ver.

## Chaves

| Variável | Onde pegar |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com → API Keys |
| `GOOGLE_PLACES_API_KEY` | https://console.cloud.google.com → ative **Places API (New)** **e** **PageSpeed Insights API** no mesmo projeto → Credentials → API key |
| `TOMTOM_API_KEY` | https://developer.tomtom.com → cadastro grátis → Dashboard → Keys. Usada na busca de empresas quando o Google não está disponível |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | https://supabase.com → seu projeto → Settings → API (chaves públicas; o acesso é protegido por RLS) |

> Sem as chaves do Supabase, o app roda em **modo local** (sem login; leads salvos no navegador). Com elas, aparece a **tela de login** e cada usuário tem os próprios leads.

### Login + banco (Supabase) — opcional

1. Crie um projeto grátis em https://supabase.com.
2. **SQL Editor → New query** → cole o conteúdo de `supabase/schema.sql` → **Run** (cria a tabela `leads` com Row Level Security).
3. **Settings → API** → copie a **Project URL** e a **anon public key** para `SUPABASE_URL` e `SUPABASE_ANON_KEY` no `.env`.
4. (Opcional) **Authentication → Providers → Email**: mantenha e-mail/senha ligado. Para testar rápido, desative a confirmação de e-mail.
5. `npm start` → agora abre com tela de login, e os leads salvos ficam na conta.

## Como funciona

1. **Buscar** (`POST /api/search`) → devolve empresas reais + o diagnóstico base. O servidor consulta **todas as fontes que tiverem chave** ao mesmo tempo (**Google Places**, **Foursquare**, **HERE**, **TomTom**) e **junta o resultado**: a mesma empresa vira um card só com os dados de todas (site, nota, e-mail, redes) e o telefone que aparece em 2 fontes vem como **confirmado**. O **OpenStreetMap** só entra se nenhuma responder. Quem falha fica 10 min em pausa. Se todos falharem, o site mostra o motivo de cada um e cai em modo demonstração. Obs.: os servidores públicos do OpenStreetMap costumam bloquear hospedagem em nuvem (acontece no Render).
2. **Abrir uma empresa** → o front chama **`POST /api/enrich`**, que:
   - lê o **próprio site** da empresa procurando link de **Instagram** e de **WhatsApp**;
   - roda o **PageSpeed Insights** pra medir o desempenho no **celular**.
   Só vira "gap" o que foi de fato verificado — diagnóstico honesto.
3. **Mensagem** (`POST /api/message`) → o diagnóstico vira contexto e a **API da Claude** escreve a abordagem (com os tons Consultivo / Direto / Curto).
4. **WhatsApp** → botão abre `wa.me` com a mensagem já preenchida.

### O que é fonte legítima (e o que evitamos)

Usamos só **APIs oficiais** (Google Places, PageSpeed) e a **página pública da própria empresa**. Não há scraping de Google Maps, Instagram, Facebook ou TikTok — isso viola os termos deles, quebra toda hora e derruba sua conta/IP.

## Estrutura

```
radar-b2b/
├── server.js              # Express: serve o front-end + a API
├── public/
│   └── index.html         # front-end (login + busca + diagnóstico + abordagem)
├── src/
│   ├── places.js          # Google Places API (busca de empresas)
│   ├── audit.js           # diagnóstico de gaps (só sinais verificados)
│   ├── enrich.js          # lê o site + PageSpeed (enriquecimento)
│   └── message.js         # geração da abordagem via API da Claude
├── supabase/
│   └── schema.sql         # tabela de leads + Row Level Security
├── package.json
├── .env.example
└── .gitignore
```

## Endpoints

| Método | Rota | Body | Retorno |
|---|---|---|---|
| POST | `/api/search` | `{ niche, city }` | `{ results: [...] }` (empresas + `gaps` + `heat`) |
| POST | `/api/enrich` | `{ biz }` | `{ enrichment, gaps, heat }` |
| POST | `/api/message` | `{ biz, gaps, sellerName, tone }` | `{ message }` |
| GET | `/api/wa` | `?phone=&text=` | `{ url }` |
| GET | `/api/config` | — | `{ supabaseUrl, supabaseAnonKey }` (público) |
| GET | `/api/health` | — | `{ ok: true }` |

## Próximos passos sugeridos

- **Login + banco (Supabase): já incluso.** Configure as chaves do Supabase (seção acima) e cada usuário ganha login + seus próprios leads/funil na nuvem. Sem as chaves, segue em modo local (navegador).
- **Custo da Claude**: a geração usa `claude-opus-5-5` com `effort:"low"`. Pra muito volume, troque `CLAUDE_MODEL` por `claude-sonnet-5-5` ou `claude-haiku-5-5`.
- **LGPD / WhatsApp**: dado comercial público, base legal registrada (legítimo interesse B2B), identificação na 1ª mensagem, opção de saída e sem disparo em massa.

## Deploy

É um app Node comum: sobe em Render, Railway, Fly.io, uma VPS, etc. Configure as mesmas variáveis do `.env` no painel do provedor e o comando de start `npm start`.

## Qualidade dos telefones (como o Faro classifica)

Cada empresa traz uma ficha de telefone (`phoneInfo`) com **status**, **origem** de cada número e **alertas**.

| Status | Significa | NÃO significa |
|---|---|---|
| `business_confirmed` | o número aparece no **site da própria empresa** (tel:, wa.me, dados estruturados ou texto) | que o WhatsApp está ativo |
| `format_valid` | DDD existe, tamanho e dígitos de um número brasileiro real | que existe, é da empresa ou tem WhatsApp |
| `unverified` | formato ok, mas com alerta (ex.: DDD de outro estado) | — |
| `invalid_format` | formato impossível (sem DDD, DDD inexistente, dígitos repetidos/sequência, celular sem 9, vários números no campo…) | — |

- **WhatsApp** é um campo separado e começa sempre como `whatsapp_unverified`. Só vira `whatsapp_published` se o site da empresa publica um link wa.me com aquele número. O Faro **não envia mensagens** nem testa se o número tem WhatsApp; abrir `wa.me` não prova nada.
- **2+ fontes com o mesmo número** é só "corroborado" (bases públicas copiam umas das outras), não confirmação.
- Números são normalizados para E.164 (+55), mas o texto original da fonte é guardado (`raw`). O Faro nunca adivinha DDD nem o 9º dígito.
- Fontes com números diferentes: mantém o de maior confiança (status, concordância, data de atualização quando a fonte informa, prioridade da fonte), lista os outros em `alternatives` com a origem e marca `phone_divergence`. Nada é trocado automaticamente.
- Duplicatas: telefone igual **não** junta empresas (redes de lojas dividem número). Junta por nome parecido + coordenadas/endereço; casos incertos ficam separados e marcados em `possibleDuplicates`. Os registros originais ficam em `records`.
- Foursquare: se o plano liberar, usa `date_refreshed` (data da fonte) e ignora cadastros com `date_closed`. As outras fontes não informam data de verificação; a tela mostra só a data em que o Faro consultou.

### Custos e limites
Nenhuma API paga foi adicionada. Buscas ficam em cache (`SEARCH_CACHE_MINUTES`, padrão 360; resultados parciais não são guardados), leitura de sites tem cache de 24h e no máx. 4 ao mesmo tempo, e há limite de pedidos por IP (`RATE_SEARCH_PER_MIN`=20, `RATE_ENRICH_PER_MIN`=120, `RATE_MESSAGE_PER_MIN`=30). Checar de verdade se um número tem WhatsApp exigiria a API oficial do WhatsApp Business (paga/com aprovação) ou serviços de validação de telefone pagos; por isso o Faro não afirma isso.

### Testes
`npm test` (usa o `node --test`, só com números sintéticos de teste).

## Envio em massa (fila de WhatsApp + e-mail)

Selecionando várias empresas na lista de resultados (checkbox no card) aparece uma barra com duas opções:

- **Fila de WhatsApp (semi-automática):** o Faro **nunca manda mensagem sozinho** — ele abre, uma a uma, a conversa já preenchida no WhatsApp Web/app (`wa.me`), e **você aperta Enviar** em cada uma. O botão "Abrir próxima conversa" cicla pela fila; o seletor de intervalo só coloca uma pausa (cooldown) entre as aberturas, pra você não clicar rápido demais. Empresas sem celular de formato válido ficam de fora automaticamente, listadas no aviso. Isso é proposital: não existe WhatsApp grátis "programável" (só a WhatsApp Business API, paga), e simular cliques automáticos viola os termos do WhatsApp e arrisca banir seu número.
- **E-mail em massa:** manda de verdade, um clique envia pra todos os selecionados que têm e-mail encontrado. Só aparece quando há um provedor de e-mail configurado no servidor (variáveis `RESEND_API_KEY`+`RESEND_FROM` ou `BREVO_API_KEY`+`BREVO_FROM` — ambos têm plano grátis). Cada envio é sequencial e volta com o resultado individual (enviado/falhou); no máximo 50 por lote.

### Testes
`npm test` também cobre `src/mailer.js` (com `fetch` mockado, sem gastar cota de verdade).
