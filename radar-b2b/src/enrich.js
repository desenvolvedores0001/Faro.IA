// Enriquecimento do diagnóstico — SÓ com fontes legítimas:
//  1) Lê o PRÓPRIO site da empresa (página pública dela): procura e-mail de contato,
//     links de redes sociais (Instagram, Facebook, TikTok, LinkedIn, YouTube) e WhatsApp.
//  2) Roda o Google PageSpeed Insights (API oficial) para medir o desempenho do site
//     no celular (pulado no modo `light`).
// Nada de scraping de Instagram/Facebook/Maps. Se uma checagem falha, o sinal fica
// `null`/vazio e o audit NÃO inventa o gap.

import dns from "node:dns/promises";
import net from "node:net";
import { cached, limiter, peek } from "./cache.js";

const siteSlots = limiter(4); // no máximo 4 sites lidos ao mesmo tempo
const ENRICH_CACHE_MS = 24 * 60 * 60 * 1000;

const PAGESPEED_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const UA = "RadarB2B/0.3 (diagnostico de presenca digital)";

// --------------------------------------------------- segurança (SSRF) ----
// O endereço do site vem do navegador. Sem esta checagem, alguém poderia pedir ao
// servidor para abrir endereços internos. Só aceitamos http(s) para hosts públicos.

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x.startsWith("::ffff:")) {
      const rest = x.slice(7);
      return net.isIPv4(rest) ? isPrivateIp(rest) : true;
    }
    return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb");
  }
  return true;
}

export async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocolo não permitido");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan)$/.test(host)) throw new Error("host não permitido");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("endereço não permitido");
  return u;
}

// Segue no máximo 3 redirecionamentos, revalidando cada destino, e lê no máximo maxBytes.
async function fetchText(raw, { timeoutMs = 7000, maxBytes = 500_000, hops = 3 } = {}) {
  let url = raw;
  for (let i = 0; i <= hops; i++) {
    const u = await assertPublicUrl(url);
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, u).href;
      continue;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const type = res.headers.get("content-type") || "";
    if (type && !/text\/|xhtml|xml/i.test(type)) throw new Error("não é página HTML");
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) break;
    }
    return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
  }
  throw new Error("redirecionamentos demais");
}

// --------------------------------------------------------- extração ----

const BAD_EMAIL = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?)$|sentry|wixpress|example\.|exemplo\.|seudominio|yourdomain|domain\.com|email\.com|@2x|@3x|noreply|no-reply|donotreply|u003e/i;
const ROLE = /^(contato|contact|comercial|vendas|atendimento|sac|info|ola|oi|financeiro|reservas|faleconosco|marketing|orcamento)/i;

const normalizeHtml = (html) =>
  html
    .replace(/\\\//g, "/") // JSON escapado: https:\/\/site
    .replace(/&#0*64;|&#x0*40;|&commat;|%40/gi, "@")
    .replace(/&#0*46;|&#x0*2e;|&period;/gi, ".");

export function extractEmails(html, siteUrl) {
  const text = normalizeHtml(html);
  const found = new Set();
  const add = (raw) => {
    let e = String(raw).trim().toLowerCase().replace(/[.,;:)>\]]+$/, "");
    try { e = decodeURIComponent(e); } catch (_) { /* mantém */ }
    if (e.length > 80 || BAD_EMAIL.test(e)) return;
    if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(e)) return;
    found.add(e);
  };
  for (const m of text.matchAll(/mailto:([^"'?\s<>]+)/gi)) add(m[1]);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g)) add(m[0]);

  let root = "";
  try { root = new URL(siteUrl).hostname.replace(/^www\./, ""); } catch (_) { /* sem site */ }
  const score = (e) => {
    const dom = e.split("@")[1];
    const same = root && (dom === root || root.endsWith("." + dom) || dom.endsWith("." + root));
    return (same ? 0 : 2) + (ROLE.test(e) ? 0 : 1); // do domínio da empresa e com cara de "contato" primeiro
  };
  return [...found].sort((a, b) => score(a) - score(b)).slice(0, 3);
}

const NOT_PROFILE = {
  instagram: /^(p|reel|reels|tv|explore|accounts|share|stories|direct|about|developer|legal|privacy|web|oauth|embed)$/i,
  facebook: /^(sharer|sharer\.php|share|share\.php|plugins|tr|dialog|login|login\.php|policies|help|legal|privacy|groups|events|watch|marketplace|gaming|hashtag|l\.php|ads|business|public)$/i,
};

export function extractSocial(html) {
  const text = normalizeHtml(html);
  const out = {};
  const pick = (re, build, skip) => {
    for (const m of text.matchAll(re)) {
      const seg = m[1];
      if (skip && skip.test(seg.split(/[/?]/)[0])) continue;
      return build(seg);
    }
    return undefined;
  };
  out.instagram = pick(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})(?=[/"'\s<?#]|$)/gi, (s) => `https://instagram.com/${s}`, NOT_PROFILE.instagram);
  out.facebook = pick(/https?:\/\/(?:www\.|m\.|pt-br\.)?facebook\.com\/((?:pages\/[^"'\s<>?#]+|profile\.php\?id=\d+|[A-Za-z0-9.\-]{3,}))/gi, (s) => `https://facebook.com/${s}`, NOT_PROFILE.facebook);
  out.tiktok = pick(/https?:\/\/(?:www\.)?tiktok\.com\/(@[A-Za-z0-9._]{2,30})/gi, (s) => `https://tiktok.com/${s}`);
  out.linkedin = pick(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company\/[A-Za-z0-9._\-%]+)/gi, (s) => `https://linkedin.com/${s}`);
  out.youtube = pick(/https?:\/\/(?:www\.)?youtube\.com\/((?:@|c\/|channel\/|user\/)[A-Za-z0-9._\-]+)/gi, (s) => `https://youtube.com/${s}`);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

function extractWhatsapp(html) {
  const text = normalizeHtml(html);
  const link = /wa\.me\/|api\.whatsapp\.com|whatsapp:\/\/|href=["'][^"']*whatsapp/i.test(text);
  const num = text.match(/wa\.me\/(?:message\/)?(\d{10,15})/i) || text.match(/[?&]phone=(\d{10,15})/i);
  return { link, number: num ? num[1] : null };
}

/**
 * Telefones que o PRÓPRIO site publica, separados por onde aparecem (quanto mais "de contato", mais forte):
 * tel: (links de ligar), whatsapp (wa.me / api.whatsapp.com), jsonld (dados estruturados "telephone") e
 * text (texto visível da página). Só captura; a validação de formato fica em phone.js.
 */
export function extractPhones(html) {
  const text = normalizeHtml(html);
  const uniq = (a) => [...new Set(a.map((x) => x.trim()).filter(Boolean))].slice(0, 6);
  const dec = (v) => { try { return decodeURIComponent(v); } catch (_) { return v; } };
  const tel = [...text.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => dec(m[1]));
  const whatsapp = [
    ...[...text.matchAll(/wa\.me\/(\d{10,15})/gi)].map((m) => m[1]),
    ...[...text.matchAll(/(?:api|web)\.whatsapp\.com\/send\/?\?[^"'\s]*?phone=(\d{10,15})/gi)].map((m) => m[1]),
    ...[...text.matchAll(/whatsapp:\/\/send\?[^"'\s]*?phone=(\d{10,15})/gi)].map((m) => m[1]),
  ];
  const jsonld = [...text.matchAll(/"(?:telephone|phone)"\s*:\s*"([^"]{8,30})"/gi)].map((m) => m[1]);
  const visible = text
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ")
    .replace(/&nbsp;|&#160;/gi, " ");
  const txt = [...visible.matchAll(/(?<![\d])(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?(?:9[\s.-]?)?\d{4}[\s.-]?\d{4}(?![\d])/g)].map((m) => m[0]);
  return { tel: uniq(tel), whatsapp: uniq(whatsapp), jsonld: uniq(jsonld), text: uniq(txt) };
}

function contactPageUrl(html, siteUrl) {
  const m = html.match(/href=["']([^"'#]*(?:contato|contact|fale-conosco|faleconosco|atendimento)[^"']*)["']/i);
  if (!m) return null;
  try {
    const u = new URL(m[1], siteUrl);
    return u.hostname === new URL(siteUrl).hostname ? u.href : null; // só o mesmo site
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------- PageSpeed ----

async function pageSpeedMobileScore(url) {
  const u = new URL(PAGESPEED_URL);
  u.searchParams.set("url", url);
  u.searchParams.set("strategy", "mobile");
  u.searchParams.set("category", "performance");
  const key = process.env.PAGESPEED_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (key) u.searchParams.set("key", key);

  let res = await fetch(u, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok && key) {
    // chave inválida/sem a API ativada: tenta de novo sem chave (cota menor, mas funciona)
    u.searchParams.delete("key");
    res = await fetch(u, { signal: AbortSignal.timeout(25_000) });
  }
  if (!res.ok) throw new Error("PageSpeed HTTP " + res.status);
  const data = await res.json();
  const score = data?.lighthouseResult?.categories?.performance?.score;
  return typeof score === "number" ? score : null; // 0..1
}

/**
 * Sinais verificados sobre a empresa, a partir do site dela.
 * @param {{website?:string}} biz
 * @param {{light?:boolean}} opts  light = só lê o site (sem PageSpeed): rápido, p/ varrer vários
 */
async function enrichUncached(biz, { light = false } = {}) {
  const out = {
    mobileScore: null, whatsapp: null, instagram: null, checkedSite: false,
    emails: [], social: {}, whatsappNumber: null,
    sitePhones: { tel: [], whatsapp: [], jsonld: [], text: [] }, checkedAt: null,
  };
  if (!biz?.website) return out; // sem site não há o que ler

  try {
    const home = await fetchText(biz.website);
    out.checkedSite = true;
    const wa = extractWhatsapp(home);
    out.whatsapp = wa.link;
    out.whatsappNumber = wa.number;
    out.instagram = /instagram\.com\//i.test(normalizeHtml(home)); // qualquer link (base do gap "sem Instagram")
    out.social = extractSocial(home);
    out.emails = extractEmails(home, biz.website);
    out.sitePhones = extractPhones(home);
    out.checkedAt = new Date().toISOString();

    // sem e-mail na página inicial: tenta a página de contato do mesmo site
    if (!out.emails.length) {
      const contact = contactPageUrl(home, biz.website);
      if (contact) {
        try {
          const page = await fetchText(contact);
          out.emails = extractEmails(page, biz.website);
          out.social = { ...extractSocial(page), ...out.social };
          if (!out.whatsappNumber) out.whatsappNumber = extractWhatsapp(page).number;
          const more = extractPhones(page);
          for (const k of Object.keys(out.sitePhones)) out.sitePhones[k] = [...new Set([...out.sitePhones[k], ...more[k]])].slice(0, 6);
        } catch (_) { /* página de contato indisponível */ }
      }
    }
  } catch (_) {
    /* site fora do ar, bloqueou o acesso ou endereço não permitido: segue sem os sinais */
  }

  if (!light) {
    try {
      out.mobileScore = await pageSpeedMobileScore(biz.website);
    } catch (_) {
      /* sem PageSpeed agora: segue sem o sinal */
    }
  }
  return out;
}

/** Com cache de 24h por site (e limite de leituras simultâneas): reabrir a mesma empresa não refaz a leitura. */
export function enrichBusiness(biz, { light = false } = {}) {
  if (!biz?.website) return enrichUncached(biz, { light });
  const run = () => siteSlots(() => enrichUncached(biz, { light }));
  // a leitura completa (com PageSpeed) também serve para o pedido "light", não o contrário
  if (light) {
    const full = peek("enrich:full:" + biz.website);
    if (full) return Promise.resolve(full);
    return cached("enrich:light:" + biz.website, ENRICH_CACHE_MS, run);
  }
  return cached("enrich:full:" + biz.website, ENRICH_CACHE_MS, run);
}
