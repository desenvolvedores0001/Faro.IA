// Gera a mensagem de abordagem com a API oficial da Claude (@anthropic-ai/sdk).
import Anthropic from "@anthropic-ai/sdk";

// O construtor sem argumentos lê a chave de ANTHROPIC_API_KEY no ambiente.
const client = new Anthropic();

// Padrão: claude-opus-5-5 (mais capaz). Para alto volume, troque CLAUDE_MODEL
// por claude-sonnet-5-5 ou claude-haiku-5-5 (mais baratos) — decisão sua.
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const SYSTEM = `Você escreve mensagens de PRIMEIRA abordagem comercial (B2B) para WhatsApp e
e-mail, em português do Brasil, com a voz de um profissional sênior: cordial, seguro e
objetivo. Nem robótico, nem informal demais.

Linguagem:
- Gramática e pontuação corretas. Concordância, artigos e preposições certos
  (ex.: "a Barbearia X", "o Restaurante Y", "na Bahia", "no Paraná", "em Minas Gerais").
- Nada de gírias ou abreviações ("pra", "tá", "vc", "aí"), emojis, exclamações em
  excesso, caixa alta, aspas ou parênteses decorativos, jargão de marketing ou frases
  de vendedor ("promoção imperdível", "oportunidade única").
- Trate a empresa por "vocês"; "te" é aceitável na pergunta final.

Estrutura (parágrafos curtos, separados por uma linha em branco):
1. "Olá, tudo bem? Meu nome é <vendedor>." e, em seguida, a "apresentacao" como frase
   própria. A apresentação é OBRIGATÓRIA em toda mensagem.
2. Explique de onde veio o contato: a equipe está pesquisando comércios do ramo e da
   região para analisar a presença digital de cada um (não cite Google Maps nem
   nenhuma plataforma). Diga o que a análise encontrou (a "observacao" mais forte; se
   for ausência de site, diga que não encontraram um site próprio da empresa) e o
   impacto disso. Se a nota for 4 ou mais com pelo menos 5 avaliações, parabenize.
3. Diga que gostariam de apresentar uma proposta para a "solucao" e feche de forma
   elegante e cordial, sem pergunta de vendedor. Evite "faz sentido?" e "sem compromisso".
   Exemplo: "Ficamos à disposição para apresentar os detalhes em uma conversa rápida,
   no melhor horário para vocês."

Regras:
- Escreva sempre na primeira pessoa do plural ("estamos", "gostaríamos", "trabalhamos"),
  exceto em "Meu nome é <vendedor>".
- Tamanho conforme o tom: "consultivo" até 110 palavras; "direto" até 80; "curto" até 55.
- Use SOMENTE os dados fornecidos. Não invente nota, número, cliente, prazo, preço nem serviço.
- Responda APENAS com o texto da mensagem, sem título, aspas ou comentários.`;

/**
 * @param {object}   p
 * @param {object}   p.biz        empresa (name, city, rating, reviews...)
 * @param {object[]} p.gaps       gaps do audit.js
 * @param {string}   p.sellerName quem assina
 * @param {string}   p.about      como o vendedor/equipe se apresenta (opcional)
 * @param {string}   p.tone       "consultivo" | "direto" | "curto"
 */
export async function generateMessage({ biz, gaps = [], sellerName, about, tone = "consultivo" }) {
  const contexto = {
    empresa: biz.name,
    ramo: biz.niche,
    local: biz.city,
    nota: biz.rating,
    avaliacoes: biz.reviews,
    vendedor: String(sellerName || "").trim() || "(não informado)",
    apresentacao: String(about || "").trim() || "Somos uma equipe de três profissionais especializada em criação de sites",
    tom: ["consultivo", "direto", "curto"].includes(tone) ? tone : "consultivo",
    oportunidades: gaps.slice(0, 2).map((g) => ({
      problema: g.title,
      observacao: g.pain,
      impacto: g.impact,
      solucao: g.solution,
      servico: g.service || g.offer,
    })),
  };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 600,
    output_config: { effort: "low" }, // tarefa simples -> menos custo e latência
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content:
          "Escreva a mensagem de abordagem com base neste diagnóstico (JSON):\n\n" +
          JSON.stringify(contexto, null, 2),
      },
    ],
  });

  // Em modelos novos é obrigatório checar refusal antes de ler o conteúdo.
  if (response.stop_reason === "refusal") {
    throw new Error(
      "O modelo recusou gerar a mensagem: " + (response.stop_details?.explanation || "sem detalhe")
    );
  }

  const text = response.content.find((b) => b.type === "text")?.text?.trim();
  return text || "";
}
