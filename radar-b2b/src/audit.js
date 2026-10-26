// Monta os "gaps" (oportunidades) a partir dos sinais que REALMENTE temos.
//
// Sem enriquecimento, as bases de empresas entregam com segurança: tem site?, nota,
// avaliações, telefone. Passe `enrichment` (de src/enrich.js) para aprofundar:
// desempenho mobile (PageSpeed), link de WhatsApp e de Instagram no site.
// Regra de ouro: só afirmamos um gap quando o sinal foi de fato verificado —
// um diagnóstico falso queima a abordagem.
//
// Cada gap traz, além do texto da tela (title/desc/offer), as peças da mensagem de
// abordagem, escritas para se encaixar em frases prontas sem quebrar a gramática:
//   pain      oração que completa "notei que ___" (minúscula, sem ponto final)
//   impact    frase completa sobre o efeito no negócio
//   solution  infinitivo que completa "posso ajudar a ___"
//   service   o que o vendedor faz, completando "trabalho com ___"

export function auditBusiness(biz, enrichment = {}) {
  const gaps = [];

  if (!biz.website) {
    // Bases comerciais/abertas podem estar incompletas: não afirmamos que o site não
    // existe, só que a empresa não aparece com um. Mantém o texto honesto.
    const unsure = Boolean(biz.source) && biz.source !== "google";
    const fontes = (biz.sources || []).length;
    gaps.push({
      sev: "crit",
      title: unsure ? "Sem site encontrado" : "Não tem site próprio",
      offer: "Criação de site",
      desc: unsure
        ? `Nenhum site cadastrado para a empresa${fontes > 1 ? ` nas ${fontes} fontes consultadas` : ""}. Vale confirmar no Google antes da abordagem.`
        : "Sem uma página própria, a empresa perde visibilidade nas buscas do Google.",
      pain: unsure ? "a empresa não aparece com um site próprio nas buscas" : "a empresa ainda não tem um site próprio",
      impact:
        "Hoje, a maioria dos clientes procura no Google antes de decidir, e quem não tem um site acaba perdendo essa oportunidade para a concorrência.",
      solution: "desenvolver um site profissional, rápido e pensado para transformar visitas em contatos",
      service: "criação de sites",
    });
  } else {
    // --- sinais de enriquecimento (só entram se foram verificados) ---
    if (enrichment.mobileScore != null) {
      const nota = Math.round(enrichment.mobileScore * 100);
      if (enrichment.mobileScore < 0.5) {
        gaps.push({
          sev: "crit",
          title: "Site com desempenho ruim no celular",
          offer: "Site responsivo",
          desc: `Nota de desempenho mobile baixa (${nota}/100 no PageSpeed).`,
          pain: "o site de vocês tem um desempenho baixo no celular",
          impact: "Como a maior parte das visitas vem do celular, isso costuma afastar clientes antes mesmo do primeiro contato.",
          solution: "deixar o site rápido e bem adaptado ao celular",
          service: "otimização de sites",
        });
      } else if (enrichment.mobileScore < 0.75) {
        gaps.push({
          sev: "warn",
          title: "Site lento no celular",
          offer: "Otimização de performance",
          desc: `Desempenho mobile mediano (${nota}/100). Páginas lentas reduzem a conversão.`,
          pain: "o site de vocês carrega devagar no celular",
          impact: "Cada segundo de espera reduz as chances de o visitante entrar em contato.",
          solution: "deixar o site mais rápido no celular",
          service: "otimização de sites",
        });
      }
    }

    if (/^http:\/\//i.test(biz.website)) {
      gaps.push({
        sev: "warn",
        title: "Site sem HTTPS (cadeado)",
        offer: "Certificado/segurança",
        desc: "Sem o certificado, o navegador avisa o visitante de que o site não é seguro.",
        pain: "o site de vocês ainda não usa uma conexão segura",
        impact: "Nesses casos, o visitante é avisado de que há um risco ao acessar a página, o que afasta boa parte do público.",
        solution: "deixar o site protegido, sem nenhum alerta no navegador",
        service: "manutenção de sites",
      });
    }

    if (enrichment.whatsapp === false) {
      gaps.push({
        sev: "warn",
        title: "Sem WhatsApp no site",
        offer: "Automação de atendimento",
        desc: "Nenhum link ou botão de WhatsApp na página. Cada passo a mais afasta o cliente.",
        pain: "o site de vocês não tem um botão de WhatsApp",
        impact: "Quanto mais simples for o caminho até o primeiro contato, maior a chance de o visitante se tornar cliente.",
        solution: "integrar o WhatsApp ao site para que os clientes falem com vocês em um clique",
        service: "automação de atendimento",
      });
    }

    if (enrichment.instagram === false) {
      gaps.push({
        sev: "warn",
        title: "Sem Instagram no site",
        offer: "Gestão de redes",
        desc: "O site não traz link para o Instagram. Vale verificar se o perfil existe e está ativo.",
        pain: "o site de vocês não direciona para o Instagram da empresa",
        impact: "É lá que muitos clientes conhecem a empresa antes de decidir.",
        solution: "conectar o site ao Instagram para fortalecer a presença digital da empresa",
        service: "gestão de redes sociais",
      });
    }
  }

  gaps.sort((a, b) => (a.sev === "crit" ? 0 : 1) - (b.sev === "crit" ? 0 : 1));
  return gaps;
}

// "Temperatura" do lead: reputação boa + gap crítico = quente.
export function leadHeat(biz, gaps) {
  const crit = gaps.filter((g) => g.sev === "crit").length;
  // sem nota (dados do OpenStreetMap): lead quente = tem gap crítico E telefone
  if (biz.rating == null) {
    if (crit >= 1 && biz.phone) return "quente";
  } else if (biz.rating >= 4.5 && crit >= 1) return "quente";
  if (gaps.length >= 2) return "morno";
  if (gaps.length === 0) return "frio";
  return "morno";
}
