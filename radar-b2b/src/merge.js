// Junta empresas vindas de fontes diferentes (Google, Foursquare, HERE, TomTom, OSM).
// A mesma empresa aparece uma vez só, com os dados de todas as fontes. Os registros originais
// ficam em `records` (auditoria), cada campo guarda de qual fonte veio, e quando as fontes
// discordam (telefone, site, endereço) a divergência é sinalizada em vez de escondida.
// O telefone vira uma ficha `phoneInfo` (ver quality.js).

import { phoneKey } from "./phone.js";
import { buildPhoneInfo, legacyPhoneFields, sourceRank as rank } from "./quality.js";

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const STOP = new Set(["ltda", "me", "eireli", "epp", "sa", "de", "da", "do", "das", "dos", "e", "the"]);
const tokens = (name) =>
  norm(name)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t));

/** 0..1: quão parecidos são dois nomes de empresa. */
export function nameSim(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return norm(a).trim() && norm(a).trim() === norm(b).trim() ? 1 : 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const small = Math.min(A.size, B.size);
  const jaccard = inter / (A.size + B.size - inter);
  // um nome inteiro contido no outro ("Farmácia Saúde" x "Farmácia Saúde Centro")
  const contained = inter === small && small >= 2 ? 0.8 : 0;
  return Math.max(jaccard, contained);
}

const last8 = phoneKey;

function distanceM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const phonesOf = (x) => (x.phones && x.phones.length ? x.phones : x.phone ? [x.phone] : []);

const street = (s) => norm(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
const hasCoords = (x) => x.lat != null && x.lon != null;

/**
 * Quão seguro é que dois registros são a mesma empresa?
 *  "same"  junta num card só
 *  "maybe" NÃO junta, mas marca os dois como possível duplicata
 *  null    empresas diferentes
 * Telefone igual sozinho nunca junta (redes de lojas e prédios comerciais dividem número).
 */
export function matchLevel(a, b) {
  const sim = nameSim(a.name, b.name);
  if (sim < 0.6) return null;

  const pa = phonesOf(a).map(last8).filter((p) => p.length === 8);
  const pb = phonesOf(b).map(last8).filter((p) => p.length === 8);
  const samePhone = pa.some((p) => pb.includes(p));
  const sa = street(a.address), sb = street(b.address);
  const streetsDiffer = sa !== "" && sb !== "" && sa !== sb;

  if (hasCoords(a) && hasCoords(b)) {
    const d = distanceM(a, b);
    if (d < 150) return "same";
    if (d <= 300) return samePhone || sim >= 0.9 ? "same" : "maybe";
    return samePhone && sim >= 0.8 ? "maybe" : null; // longe: filiais diferentes
  }
  if (samePhone && !streetsDiffer) return sa !== "" || sim >= 0.9 ? "same" : "maybe";
  if (!samePhone && sim >= 0.95 && sa !== "" && sa === sb) return "same";
  if (samePhone && streetsDiffer) return "maybe";
  return sim >= 0.95 ? "maybe" : null;
}

/** Compatibilidade: true só quando a ligação é segura. */
export const sameBusiness = (a, b) => matchLevel(a, b) === "same";

function firstOf(cluster, pick) {
  for (const x of cluster) {
    const v = pick(x);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

const hostOf = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch (_) { return String(u || "").toLowerCase(); }
};

function build(cluster, city, fetchedAt) {
  cluster.sort((a, b) => rank(a.source) - rank(b.source));
  const primary = cluster[0];
  const sources = [...new Set(cluster.map((x) => x.source))];
  const flags = [];

  const out = { ...primary };
  out.name = String(primary.name).replace(/[\s,.-]+(ltda|me|eireli|epp|s\.?\s?a\.?)\.?$/i, "").trim() || primary.name;
  out.id = `${primary.source}:${primary.id}`;
  out.sources = sources;
  out.source = sources[0];
  out.website = firstOf(cluster, (x) => x.website);
  out.rating = firstOf(cluster, (x) => x.rating);
  out.reviews = firstOf(cluster, (x) => (x.rating != null ? x.reviews : null)) ?? 0;
  out.address = firstOf(cluster, (x) => x.address) || "";
  out.category = firstOf(cluster, (x) => x.category) || primary.category;
  out.emails = [...new Set(cluster.flatMap((x) => x.emails || []))].slice(0, 3);
  out.social = Object.assign({}, ...cluster.slice().reverse().map((x) => x.social || {})); // quem tem prioridade sobrescreve

  // ---- telefone: ficha com status, origem e alternativas (nada é descartado em silêncio) ----
  const candidates = cluster.flatMap((x) => phonesOf(x).map((raw) => ({ source: x.source, raw, fetchedAt: x.fetchedAt || fetchedAt, updatedAt: x.updatedAt || null })));
  const info = buildPhoneInfo(candidates, { state: city });
  out.phoneInfo = info;
  Object.assign(out, legacyPhoneFields(info));

  // ---- site e endereço: quando as fontes discordam, mostramos as duas versões ----
  const sites = [...new Map(cluster.filter((x) => x.website).map((x) => [hostOf(x.website), { url: x.website, source: x.source }])).values()];
  if (sites.length > 1) flags.push("website_divergence");
  const addrs = cluster.filter((x) => x.address);
  const distinctStreets = new Set(addrs.map((x) => street(x.address)).filter(Boolean));
  if (distinctStreets.size > 1) flags.push("address_divergence");
  out.provenance = {
    phone: info.sources.map((s) => s.source),
    website: out.website ? cluster.filter((x) => x.website && hostOf(x.website) === hostOf(out.website)).map((x) => x.source) : [],
    address: out.address ? cluster.filter((x) => x.address && street(x.address) === street(out.address)).map((x) => x.source) : [],
  };
  if (sites.length > 1) out.websiteAlternatives = sites.filter((s) => hostOf(s.url) !== hostOf(out.website));
  if (distinctStreets.size > 1) out.addressAlternatives = addrs.filter((x) => street(x.address) !== street(out.address)).map((x) => ({ address: x.address, source: x.source }));

  // ---- registros originais, como vieram ----
  out.records = cluster.map((x) => ({
    source: x.source, id: x.id, name: x.name, address: x.address || "", phone: phonesOf(x).join(" | "),
    website: x.website || null, lat: x.lat ?? null, lon: x.lon ?? null, fetchedAt: x.fetchedAt || fetchedAt,
  }));
  out.dataFlags = flags;
  delete out.phones;
  return out;
}

/** @param {object[][]} lists uma lista de empresas por fonte  @returns {object[]} empresas únicas */
export function mergeBusinesses(lists, { city, now = new Date().toISOString() } = {}) {
  const clusters = [];
  for (const list of lists) {
    for (const item of list) {
      const hit = clusters.find((c) => c.some((m) => (m.source !== item.source && sameBusiness(m, item)) || (m.id === item.id && m.source === item.source)));
      if (hit) hit.push(item);
      else clusters.push([item]);
    }
  }
  const out = clusters.map((c) => build(c, city, now));

  // possíveis duplicatas (ligação incerta, ou mesma fonte): não junta, só avisa
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const maybe = clusters[i].some((x) => clusters[j].some((y) => matchLevel(x, y) !== null));
      if (!maybe) continue;
      (out[i].possibleDuplicates ||= []).push(out[j].id);
      (out[j].possibleDuplicates ||= []).push(out[i].id);
    }
  }
  return out;
}
