// Qualidade do contato: junta o que cada fonte disse sobre o telefone numa "ficha" única
// (`phoneInfo`) com status, origem e sinais de alerta.
//
// Status (do mais fraco ao mais forte). Nenhum deles prova que o número tem WhatsApp:
//   invalid_format      formato impossível/malformado (DDD inexistente, tamanho errado, dígitos repetidos...)
//   unverified          formato ok, mas com sinal de alerta (ex.: DDD de outro estado)
//   format_valid        formato ok; só as fontes (cadastros públicos) dizem que é da empresa
//   business_confirmed  o número aparece no PRÓPRIO site/canal da empresa (evidência independente das bases)
// WhatsApp (campo à parte, nunca deduzido do tipo de número):
//   whatsapp_unverified  padrão: não sabemos se o número tem WhatsApp
//   whatsapp_published   o site da empresa publica um link de WhatsApp com este número
// "Corroborado" (2+ bases independentes trazem o mesmo número) NÃO é confirmação: bases públicas
// copiam umas das outras. É só um sinal extra de consistência.

import { analyzePhone, phoneKey } from "./phone.js";

// quem manda quando duas fontes discordam (a primeira da lista ganha)
export const PRIORITY = ["google", "foursquare", "here", "tomtom", "osm"];
export const sourceRank = (s) => {
  const i = PRIORITY.indexOf(s);
  return i === -1 ? PRIORITY.length : i;
};

const STATUS_RANK = { business_confirmed: 0, format_valid: 1, unverified: 2, invalid_format: 3 };

/**
 * @param {{source:string, raw:string, fetchedAt?:string, updatedAt?:string|null}[]} candidates números de cada fonte
 * @param {{state?:string, now?:string}} opts
 */
export function buildPhoneInfo(candidates, { state } = {}) {
  const groups = new Map(); // chave do número -> { analysis, sources[] }
  for (const c of candidates) {
    if (!c.raw || !String(c.raw).trim()) continue;
    const a = analyzePhone(c.raw, { state });
    const key = a.formatValid ? a.e164 : "raw:" + String(c.raw).replace(/\D/g, "") + ":" + a.reasons[0];
    if (!groups.has(key)) groups.set(key, { a, sources: [] });
    groups.get(key).sources.push({ source: c.source, raw: String(c.raw), fetchedAt: c.fetchedAt || null, updatedAt: c.updatedAt || null });
  }
  if (!groups.size) return emptyPhoneInfo();

  const list = [...groups.values()].map((g) => {
    const distinct = new Set(g.sources.map((s) => s.source));
    const newest = g.sources.map((s) => s.updatedAt).filter(Boolean).sort().pop() || null;
    return { ...g, n: distinct.size, best: Math.min(...[...distinct].map(sourceRank)), newest };
  });
  // desempate determinístico: formato/alerta, concordância entre fontes, mais recente, fonte mais confiável, celular
  list.sort(
    (x, y) =>
      STATUS_RANK[x.a.status] - STATUS_RANK[y.a.status] ||
      y.n - x.n ||
      (y.newest || "").localeCompare(x.newest || "") ||
      x.best - y.best ||
      (x.a.type === "mobile" ? 0 : 1) - (y.a.type === "mobile" ? 0 : 1)
  );
  const [main, ...rest] = list;
  const a = main.a;

  const flags = [...a.flags];
  const validOthers = rest.filter((g) => g.a.formatValid);
  if (a.formatValid && validOthers.length) flags.push("phone_divergence");
  if (a.formatValid && main.n >= 2) flags.push("corroborated");

  const alt = (g) => ({
    raw: g.sources[0].raw, e164: g.a.e164, national: g.a.national, type: g.a.type,
    status: g.a.status, reasons: g.a.reasons, sources: g.sources,
  });

  return {
    raw: main.sources[0].raw,
    e164: a.e164,
    national: a.national,
    type: a.type,
    ddd: a.ddd,
    status: a.status,
    reasons: a.reasons,
    flags,
    corroborated: a.formatValid && main.n >= 2,
    whatsapp: "whatsapp_unverified",
    sources: main.sources,
    evidence: [],
    alternatives: rest.map(alt),
    lastCheckedAt: candidates.map((c) => c.fetchedAt).filter(Boolean).sort().pop() || null,
    sourceUpdatedAt: main.newest,
  };
}

export const emptyPhoneInfo = () => ({
  raw: "", e164: "", national: "", type: null, ddd: null, status: "none", reasons: [], flags: [],
  corroborated: false, whatsapp: "whatsapp_unverified", sources: [], evidence: [], alternatives: [],
  lastCheckedAt: null, sourceUpdatedAt: null,
});

/** Campos antigos que o resto do app (filtros, ordenação) usa, derivados da ficha. */
export function legacyPhoneFields(info) {
  const ok = info.status === "format_valid" || info.status === "business_confirmed";
  return {
    phone: info.raw,
    phoneOk: ok,
    phoneType: ok && (info.type === "mobile" || info.type === "landline") ? info.type : null,
    // "respaldado": confirmado pela empresa OU o mesmo número em 2+ bases. NÃO é prova de WhatsApp.
    phoneConfirmed: ok && (info.status === "business_confirmed" || info.corroborated),
  };
}

/**
 * Aplica o que o site da empresa mostrou. `found` = números achados no site: { tel:[], whatsapp:[], jsonld:[], text:[] }.
 * Só vira `business_confirmed` se o número do lead estiver no site em um lugar "de contato".
 * Números do site diferentes do lead NÃO substituem o do lead: viram alternativas e um alerta.
 */
export function applySiteEvidence(info, found, { url, at = new Date().toISOString(), state } = {}) {
  if (!info || !found) return info;
  const out = { ...info, flags: [...info.flags], evidence: [...info.evidence], alternatives: [...info.alternatives] };
  const where = (kind) => (found[kind] || []).filter((r) => analyzePhone(r).formatValid);
  const kinds = ["tel", "whatsapp", "jsonld", "text"];
  const all = kinds.flatMap((k) => where(k).map((raw) => ({ kind: k, raw })));
  if (!all.length) return out;

  const mine = out.e164 ? phoneKey(out.e164) : "";
  const hit = mine ? all.filter((x) => phoneKey(analyzePhone(x.raw).e164) === mine) : [];
  if (hit.length && out.status !== "invalid_format") {
    const kind = [...new Set(hit.map((h) => h.kind))];
    // número só no texto da página ("ligue 31 3333-4444") conta; mas o ddd de outro estado continua alerta
    out.evidence.push({ type: "business_website", url, at, via: kind });
    if (out.status !== "unverified" || !out.flags.includes("ddd_other_state")) out.status = "business_confirmed";
    else out.flags.push("site_confirms_other_state_ddd");
    if (hit.some((h) => h.kind === "whatsapp")) out.whatsapp = "whatsapp_published";
  }
  // outros números que o site publica (não troca o principal)
  const known = new Set([mine, ...out.alternatives.map((x) => phoneKey(x.e164))].filter(Boolean));
  const extra = [];
  for (const x of all) {
    const a = analyzePhone(x.raw, { state });
    const k = phoneKey(a.e164);
    if (known.has(k)) continue;
    known.add(k);
    extra.push({ raw: x.raw, e164: a.e164, national: a.national, type: a.type, status: a.status, reasons: a.reasons,
      sources: [{ source: "site_da_empresa", raw: x.raw, fetchedAt: at, updatedAt: null, via: x.kind }] });
  }
  if (extra.length) {
    out.alternatives.push(...extra);
    if (out.e164 && !hit.length) out.flags.push("site_lists_other_numbers"); // site não traz o número da base
  }
  if (!out.e164 && extra.length) out.flags.push("site_lists_other_numbers");
  out.flags = [...new Set(out.flags)];
  return out;
}

/** Faixa de confiança p/ ordenar (0 = melhor). */
export function phoneTier(info) {
  if (!info || info.status === "none") return 6;
  if (info.status === "invalid_format") return 5;
  if (info.status === "unverified") return 4;
  if (info.status === "business_confirmed") return 0;
  if (info.corroborated) return 1;
  return info.type === "mobile" ? 2 : 3;
}
