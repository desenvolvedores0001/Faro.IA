// Busca de empresas em várias fontes ao mesmo tempo (as que tiverem chave), com o resultado
// juntado em merge.js:
//  - Google Places (GOOGLE_PLACES_API_KEY), Foursquare (FOURSQUARE_API_KEY),
//    HERE (HERE_API_KEY) e TomTom (TOMTOM_API_KEY), todas com plano gratuito (menos o Google).
//  - OpenStreetMap (Overpass), sem chave, só se NENHUMA das outras responder. Servidores
//    públicos que podem bloquear hospedagem em nuvem (acontece no Render).
// Cada empresa volta com `sources`, `phoneType` ("mobile" | "landline" | null),
// `phoneOk` (telefone brasileiro válido, do estado certo) e `phoneConfirmed` (2+ fontes).

import { mergeBusinesses } from "./merge.js";
import { phoneTier } from "./quality.js";
import { cached, forget } from "./cache.js";

// Marca QUANDO consultamos a fonte (a data do dado em si só existe quando a fonte informa).
// A análise do telefone acontece depois, em merge.js (ficha `phoneInfo`).
function decorate(b) {
  b.fetchedAt = new Date().toISOString();
  return b;
}

// ---------------------------------------------------------------- Google ----

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.formattedAddress",
  "places.googleMapsUri",
  "places.primaryTypeDisplayName",
].join(",");

function mapPlace(p, niche, city) {
  return {
    id: p.id,
    source: "google",
    name: p.displayName?.text || "(sem nome)",
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || "",
    website: p.websiteUri || null,
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? 0,
    address: p.formattedAddress || "",
    mapsUri: p.googleMapsUri || "",
    category: p.primaryTypeDisplayName?.text || niche,
    niche,
    city,
  };
}

async function searchGoogle({ niche, city, want, accept }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  // O Text Search do Google entrega no máximo ~60 resultados (3 páginas de 20).
  const limit = Math.min(want, 60);
  const results = [];
  let pageToken = null;

  for (let page = 0; page < 3 && results.length < limit; page++) {
    const body = {
      textQuery: `${isAllCommerce(niche) ? "comércios e lojas" : niche} em ${city}`,
      languageCode: "pt-BR",
      regionCode: "BR",
      pageSize: Math.min(20, limit - results.length),
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK + ",nextPageToken",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const detail = await res.text();
      if (page === 0) throw new Error(`Places API ${res.status}: ${detail}`);
      break; // páginas seguintes falharam: fica com o que já temos
    }

    const data = await res.json();
    for (const p of data.places || []) {
      const item = decorate(mapPlace(p, niche, city));
      if (accept(item)) results.push(item);
    }
    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
  }
  return results.slice(0, limit);
}

// ---------------------------------------------------------------- TomTom ----
// API comercial com plano gratuito (chave TOMTOM_API_KEY). Busca por texto, então
// qualquer nicho funciona. Devolve nome, telefone, site e endereço (sem nota).

const TOMTOM_URL = "https://api.tomtom.com/search/2/search/";
const TOMTOM_POI_URL = "https://api.tomtom.com/search/2/poiSearch/";

// Ponto de partida de cada estado (a capital) e raio da busca. Por isso a lista vem
// concentrada na região da capital, e não espalhada pelo estado inteiro.
const ANCHOR_RADIUS_M = 50000;
const ANCHOR = {
  acre: [-9.9747, -67.8243], alagoas: [-9.6658, -35.7353], amapa: [0.0349, -51.0694],
  amazonas: [-3.119, -60.0217], bahia: [-12.9714, -38.5014], ceara: [-3.7319, -38.5267],
  "distrito federal": [-15.7939, -47.8828], "espirito santo": [-20.3155, -40.3128],
  goias: [-16.6869, -49.2648], maranhao: [-2.5307, -44.3068], "mato grosso": [-15.6014, -56.0979],
  "mato grosso do sul": [-20.4697, -54.6201], "minas gerais": [-19.9167, -43.9345],
  para: [-1.4558, -48.4902], paraiba: [-7.1195, -34.845], parana: [-25.4284, -49.2733],
  pernambuco: [-8.0476, -34.877], piaui: [-5.0892, -42.8019], "rio de janeiro": [-22.9068, -43.1729],
  "rio grande do norte": [-5.7945, -35.211], "rio grande do sul": [-30.0346, -51.2177],
  rondonia: [-8.7612, -63.9039], roraima: [2.8235, -60.6758], "santa catarina": [-27.5954, -48.548],
  "sao paulo": [-23.5505, -46.6333], sergipe: [-10.9472, -37.0731], tocantins: [-10.1689, -48.3317],
};

const UF = {
  acre: "AC", alagoas: "AL", amapa: "AP", amazonas: "AM", bahia: "BA", ceara: "CE",
  "distrito federal": "DF", "espirito santo": "ES", goias: "GO", maranhao: "MA",
  "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG", para: "PA",
  paraiba: "PB", parana: "PR", pernambuco: "PE", piaui: "PI", "rio de janeiro": "RJ",
  "rio grande do norte": "RN", "rio grande do sul": "RS", rondonia: "RO", roraima: "RR",
  "santa catarina": "SC", "sao paulo": "SP", sergipe: "SE", tocantins: "TO",
};

// o estado aparece (por nome ou pela sigla) em algum dos textos?
function matchState(parts, state) {
  const text = norm(parts.filter(Boolean).join(" | "));
  const name = norm(state);
  if (text.includes(name)) return true;
  const uf = UF[name];
  return uf ? new RegExp(`(^|[^a-z])${uf.toLowerCase()}([^a-z]|$)`).test(text) : false;
}

function inState(r, state) {
  const a = r.address || {};
  return matchState([a.countrySubdivision, a.countrySubdivisionName, a.freeformAddress], state);
}

// Uma consulta à TomTom por um termo (ex.: "Farmácia"). Devolve as empresas já mapeadas,
// só do estado pedido e sem repetição, mas ainda sem os filtros do usuário.
async function tomtomFetch({ term: rawTerm, city, limit = 100 }) {
  const niche = rawTerm;
  const state = (city || "").split(/[-,]/)[0].trim();
  const anchor = ANCHOR[norm(state)];
  const term = String(rawTerm).replace(/[\/\\?#]/g, " ").trim();

  let u;
  if (anchor) {
    // Busca só pelo nicho, limitada a um raio em volta da capital. (Juntar o nome do estado
    // na busca faz a TomTom trazer negócios que têm "São Paulo" no NOME.)
    u = new URL(TOMTOM_POI_URL + encodeURIComponent(term) + ".json");
    u.searchParams.set("lat", String(anchor[0]));
    u.searchParams.set("lon", String(anchor[1]));
    u.searchParams.set("radius", String(ANCHOR_RADIUS_M));
  } else {
    // cidade/lugar fora da lista de estados: busca por texto livre
    u = new URL(TOMTOM_URL + encodeURIComponent(`${term} ${state}`) + ".json");
    u.searchParams.set("idxSet", "POI");
  }
  u.searchParams.set("key", process.env.TOMTOM_API_KEY);
  u.searchParams.set("countrySet", "BR");
  u.searchParams.set("language", "pt-BR");
  u.searchParams.set("limit", String(limit));

  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`TomTom ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const data = await res.json();

  let list = (data.results || []).filter((r) => r.poi?.name);
  // só o que está de fato no estado pedido. Se NADA casar, o formato do endereço
  // provavelmente é diferente do esperado: nesse caso não filtra, pra não zerar a lista.
  const inside = list.filter((r) => inState(r, state));
  if (inside.length > 0) list = inside;

  const seen = new Set();
  const out = [];
  for (const r of list) {
    const key = norm(r.poi.name) + "|" + norm(r.address?.freeformAddress);
    if (seen.has(key)) continue;
    seen.add(key);

    let website = r.poi.url || null;
    if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;

    const item = decorate({
      id: r.id,
      source: "tomtom",
      name: r.poi.name,
      phone: r.poi.phone || "",
      website,
      rating: null,
      reviews: 0,
      address: r.address?.freeformAddress || "",
      mapsUri: "",
      lat: r.position?.lat ?? null,
      lon: r.position?.lon ?? null,
      category: r.poi.categories?.[0] || niche,
      niche,
      city,
    });
    out.push(item);
  }
  return out;
}

// Ramos usados no "Todos os comércios": a cada busca sorteamos alguns, juntamos e embaralhamos.
const COMMERCE_TERMS = [
  "Restaurante", "Lanchonete", "Pizzaria", "Cafeteria", "Bar", "Padaria", "Barbearia", "Salão de beleza",
  "Clínica de estética", "Academia", "Loja de roupas", "Loja de calçados", "Farmácia", "Pet shop",
  "Supermercado", "Mercearia", "Loja de móveis", "Material de construção", "Oficina mecânica", "Auto peças",
  "Lava-rápido", "Imobiliária", "Papelaria", "Floricultura", "Assistência técnica de celular",
  "Loja de informática", "Loja de cosméticos", "Joalheria", "Loja de decoração", "Óptica", "Estúdio de tatuagem",
];
const isAllCommerce = (niche) => ["todos os comercios", "todos os segmentos"].includes(norm(niche));
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

async function searchTomTom({ niche, city, want, accept }) {
  if (isAllCommerce(niche)) {
    // "Todos os comércios": busca 6 ramos sorteados em paralelo, junta, tira repetidos e embaralha.
    // Cada empresa fica com o ramo em que foi achada (aparece no card).
    const terms = shuffle(COMMERCE_TERMS).slice(0, 6);
    const settled = await Promise.allSettled(terms.map((t) => tomtomFetch({ term: t, city, limit: 40 })));
    const ok = settled.filter((s) => s.status === "fulfilled");
    if (!ok.length) throw settled[0].reason; // todas falharam: deixa a cadeia de reserva agir
    const seen = new Set();
    const all = [];
    for (const s of ok) {
      for (const it of s.value) {
        const k = norm(it.name) + "|" + norm(it.address);
        if (!seen.has(k)) {
          seen.add(k);
          all.push(it);
        }
      }
    }
    return shuffle(all.filter(accept)).slice(0, want);
  }
  return (await tomtomFetch({ term: niche, city, limit: 100 })).filter(accept).slice(0, want);
}

// ------------------------------------------------- HERE e Foursquare ----
// Duas APIs comerciais com plano gratuito (chaves HERE_API_KEY e FOURSQUARE_API_KEY).
// ATENÇÃO: escritas de memória, sem poder testar contra as APIs reais. Se alguma resposta
// vier diferente do esperado, o motivo aparece no aviso do site e ajustamos.

// "Todos os comércios": sorteia alguns ramos, consulta cada um e junta (a mesma empresa
// repetida é eliminada depois, em merge.js).
async function fanOut(niche, { limit, mixedLimit, mixedTerms }, fetchOne) {
  if (!isAllCommerce(niche)) return fetchOne(niche, limit);
  const terms = shuffle(COMMERCE_TERMS).slice(0, mixedTerms);
  const settled = await Promise.allSettled(terms.map((t) => fetchOne(t, mixedLimit)));
  const ok = settled.filter((s) => s.status === "fulfilled");
  if (!ok.length) throw settled[0].reason;
  return ok.flatMap((s) => s.value);
}

const stateOf = (city) => (city || "").split(/[-,]/)[0].trim();
const dedupe = (items) => {
  const seen = new Set();
  return items.filter((x) => {
    const k = norm(x.name) + "|" + norm(x.address);
    return seen.has(k) ? false : (seen.add(k), true);
  });
};
const withHttp = (u) => (u && !/^https?:\/\//i.test(u) ? "https://" + u : u || null);

// ---- HERE: Geocoding & Search v1 (Discover) ----

async function hereFetch(term, limit, city) {
  const state = stateOf(city);
  const anchor = ANCHOR[norm(state)];
  const u = new URL("https://discover.search.hereapi.com/v1/discover");
  if (anchor) {
    u.searchParams.set("q", term);
    u.searchParams.set("at", `${anchor[0]},${anchor[1]}`);
    u.searchParams.set("in", `circle:${anchor[0]},${anchor[1]};r=${ANCHOR_RADIUS_M}`);
  } else {
    u.searchParams.set("q", `${term} ${state}`);
    u.searchParams.set("at", "-14.235,-51.925"); // centro do Brasil
    u.searchParams.set("in", "countryCode:BRA");
  }
  u.searchParams.set("lang", "pt-BR");
  u.searchParams.set("limit", String(Math.min(limit, 100)));
  u.searchParams.set("apiKey", process.env.HERE_API_KEY);

  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HERE ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 140)}`);
  const data = await res.json();

  let list = (data.items || []).filter((it) => it.title && (!it.resultType || it.resultType === "place"));
  const inside = list.filter((it) => matchState([it.address?.stateCode, it.address?.state, it.address?.label], state));
  if (inside.length > 0) list = inside;

  return dedupe(
    list.map((it) => {
      const contacts = it.contacts || [];
      const vals = (key) => contacts.flatMap((c) => c[key] || []).map((x) => x.value).filter(Boolean);
      const phones = [...vals("mobile"), ...vals("phone")];
      return decorate({
        id: it.id,
        source: "here",
        name: it.title,
        phone: phones[0] || "",
        phones,
        website: withHttp(vals("www")[0]),
        emails: vals("email"),
        rating: null,
        reviews: 0,
        address: it.address?.label || "",
        mapsUri: "",
        lat: it.position?.lat ?? null,
        lon: it.position?.lng ?? null,
        category: it.categories?.find((c) => c.primary)?.name || it.categories?.[0]?.name || term,
        niche: term,
        city,
      });
    })
  );
}

async function searchHere({ niche, city, want, accept }) {
  const items = await fanOut(niche, { limit: 100, mixedLimit: 30, mixedTerms: 4 }, (t, l) => hereFetch(t, l, city));
  return dedupe(items).filter(accept).slice(0, want);
}

// ---- Foursquare: Places API (nova) ----

const FSQ_FIELDS_FULL = "fsq_place_id,name,latitude,longitude,location,categories,tel,website,email,rating,stats,social_media";
// datas que o Foursquare informa (quando o plano libera): última atualização do cadastro e fechamento
const FSQ_FIELDS_DATES = FSQ_FIELDS_FULL + ",date_refreshed,date_closed";
let fsqTier = 0; // 0 = com datas, 1 = completo, 2 = básico (lembra o que a conta aceita)
const FSQ_FIELDS_BASIC = "fsq_place_id,name,latitude,longitude,location,categories";

async function foursquareFetch(term, limit, city) {
  const state = stateOf(city);
  const anchor = ANCHOR[norm(state)];

  const call = async (fields) => {
    const u = new URL("https://places-api.foursquare.com/places/search");
    u.searchParams.set("query", term);
    if (anchor) {
      u.searchParams.set("ll", `${anchor[0]},${anchor[1]}`);
      u.searchParams.set("radius", String(ANCHOR_RADIUS_M));
    } else {
      u.searchParams.set("near", `${state}, Brasil`);
    }
    u.searchParams.set("limit", String(Math.min(limit, 50)));
    u.searchParams.set("fields", fields);
    return fetch(u, {
      headers: {
        Authorization: `Bearer ${process.env.FOURSQUARE_API_KEY}`,
        "X-Places-Api-Version": process.env.FOURSQUARE_API_VERSION || "2025-06-17",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });
  };

  // campos como telefone, site e nota podem ser de plano pago: se recusar, tenta só os básicos
  const tiers = [FSQ_FIELDS_DATES, FSQ_FIELDS_FULL, FSQ_FIELDS_BASIC];
  let res;
  for (let t = fsqTier; t < tiers.length; t++) {
    res = await call(tiers[t]);
    if (res.ok || ![400, 402, 403, 422].includes(res.status)) { if (res.ok) fsqTier = t; break; }
  }
  if (!res.ok) throw new Error(`Foursquare ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 140)}`);
  const data = await res.json();

  // cadastro marcado como fechado pelo próprio Foursquare: não mostramos como contato ativo
  let list = (data.results || []).filter((p) => p.name && !p.date_closed);
  const inside = list.filter((p) => matchState([p.location?.region, p.location?.formatted_address], state));
  if (inside.length > 0) list = inside;

  return dedupe(
    list.map((p) => {
      const social = {};
      if (p.social_media?.instagram) social.instagram = `https://instagram.com/${String(p.social_media.instagram).replace(/^@/, "")}`;
      if (p.social_media?.facebook_id) social.facebook = `https://facebook.com/${p.social_media.facebook_id}`;
      return decorate({
        id: p.fsq_place_id,
        source: "foursquare",
        updatedAt: p.date_refreshed || null,
        name: p.name,
        phone: p.tel || "",
        website: withHttp(p.website),
        emails: p.email ? [p.email] : [],
        social,
        // a nota do Foursquare vai de 0 a 10; mostramos de 0 a 5 como o resto
        rating: typeof p.rating === "number" ? Math.round((p.rating / 2) * 10) / 10 : null,
        reviews: p.stats?.total_ratings ?? 0,
        address: p.location?.formatted_address || "",
        mapsUri: "",
        lat: p.latitude ?? null,
        lon: p.longitude ?? null,
        category: p.categories?.[0]?.name || term,
        niche: term,
        city,
      });
    })
  );
}

async function searchFoursquare({ niche, city, want, accept }) {
  const items = await fanOut(niche, { limit: 50, mixedLimit: 25, mixedTerms: 3 }, (t, l) => foursquareFetch(t, l, city));
  return dedupe(items).filter(accept).slice(0, want);
}

// ----------------------------------------------------------- OpenStreetMap ----

const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const OVERPASS_TIMEOUT_MS = 28000;
const UA = "RadarB2B/0.2 (prospeccao B2B)";

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

// nicho (normalizado) -> filtros Overpass
const NICHES = {
  "todos os comercios": ['["shop"]', '["amenity"~"^(restaurant|cafe|bar|fast_food|pharmacy)$"]'],
  restaurante: ['["amenity"="restaurant"]'],
  lanchonete: ['["amenity"="fast_food"]'],
  pizzaria: ['["amenity"="restaurant"]["cuisine"~"pizza"]', '["amenity"~"restaurant|fast_food"]["name"~"pizz",i]'],
  cafeteria: ['["amenity"="cafe"]'],
  bar: ['["amenity"~"^(bar|pub)$"]'],
  padaria: ['["shop"="bakery"]'],
  barbearia: ['["shop"="hairdresser"]["name"~"barbear|barber",i]', '["shop"="hairdresser"]["male"="yes"]'],
  "salao de beleza": ['["shop"~"^(hairdresser|beauty)$"]'],
  "clinica de estetica": ['["shop"="beauty"]', '["name"~"estetic",i]["shop"]', '["healthcare"="aesthetic"]'],
  academia: ['["leisure"="fitness_centre"]'],
  "loja de roupas": ['["shop"="clothes"]'],
  "loja de calcados": ['["shop"="shoes"]'],
  farmacia: ['["amenity"="pharmacy"]'],
  "pet shop": ['["shop"="pet"]'],
  supermercado: ['["shop"="supermarket"]'],
  mercearia: ['["shop"~"^(convenience|greengrocer)$"]'],
  "loja de moveis": ['["shop"="furniture"]'],
  "material de construcao": ['["shop"~"^(doityourself|hardware|trade)$"]'],
  "oficina mecanica": ['["shop"="car_repair"]'],
  "auto pecas": ['["shop"="car_parts"]'],
  "lava-rapido": ['["amenity"="car_wash"]'],
  imobiliaria: ['["office"="estate_agent"]'],
  "escritorio de advocacia": ['["office"="lawyer"]'],
  "escritorio de contabilidade": ['["office"="accountant"]'],
  "clinica medica": ['["amenity"~"^(clinic|doctors)$"]'],
  "clinica odontologica": ['["amenity"="dentist"]'],
  optica: ['["shop"="optician"]'],
  papelaria: ['["shop"="stationery"]'],
  floricultura: ['["shop"="florist"]'],
  "assistencia tecnica de celular": ['["shop"="mobile_phone"]', '["shop"="electronics"]["name"~"celular|assist",i]'],
  "loja de informatica": ['["shop"~"^(computer|electronics)$"]'],
  hotel: ['["tourism"="hotel"]'],
  pousada: ['["tourism"~"^(guest_house|hostel|motel)$"]'],
  "escola / curso": ['["amenity"~"^(school|language_school|music_school|driving_school|college)$"]'],
  "loja de cosmeticos": ['["shop"~"^(cosmetics|perfumery)$"]'],
  joalheria: ['["shop"="jewelry"]'],
  "loja de decoracao": ['["shop"~"^(interior_decoration|houseware)$"]'],
  "estudio de tatuagem": ['["shop"="tattoo"]'],
};

function nicheFilters(niche) {
  const key = norm(niche);
  if (NICHES[key]) return NICHES[key];
  // nicho livre: casa pelo nome em lojas, serviços e escritórios
  const t = key.replace(/[^a-z0-9 ]/g, " ").trim();
  if (!t) return ['["shop"]["name"]'];
  return [`["shop"]["name"~"${t}",i]`, `["amenity"]["name"~"${t}",i]`, `["office"]["name"~"${t}",i]`];
}

export function buildOverpassQuery(areaName, niche, limit) {
  const safe = (areaName || "").replace(/["\\]/g, "").trim();
  const parts = [];
  for (const f of nicheFilters(niche)) {
    parts.push(`node${f}["name"](area.a);`);
    parts.push(`way${f}["name"](area.a);`);
  }
  return (
    `[out:json][timeout:25];` +
    // estado (admin_level 4) ou município (8) com esse nome
    `area["boundary"="administrative"]["name"="${safe}"]["admin_level"~"^(4|8)$"]->.a;` +
    `(${parts.join("")});out tags center ${limit};`
  );
}

// Tenta todos os servidores ao mesmo tempo e usa o primeiro que responder.
// Se todos falharem, o erro lista o motivo de cada um (aparece no aviso do site).
async function runOverpass(query) {
  const errors = [];
  const controllers = [];

  const attempts = OVERPASS_MIRRORS.map(async (url) => {
    const host = new URL(url).host;
    const ac = new AbortController();
    controllers.push(ac);
    const timer = setTimeout(() => ac.abort(new Error("timeout")), OVERPASS_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
        body: "data=" + encodeURIComponent(query),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      // o Overpass responde 200 com "remark" quando a consulta estoura o tempo/memória
      if (data.remark && /error|timed out|memory/i.test(data.remark) && !(data.elements || []).length) {
        throw new Error("consulta recusada (" + String(data.remark).slice(0, 60) + ")");
      }
      return data;
    } catch (e) {
      const m = String(e.message || e);
      if (m !== "done") errors.push(`${host}: ${m === "timeout" ? "sem resposta em " + OVERPASS_TIMEOUT_MS / 1000 + "s" : m}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });

  try {
    const data = await Promise.any(attempts);
    controllers.forEach((c) => c.abort(new Error("done"))); // cancela os que sobraram
    return data;
  } catch (_) {
    throw new Error("OpenStreetMap indisponível: " + errors.join(" | "));
  }
}

const addressOf = (t) =>
  [t["addr:street"], t["addr:housenumber"], t["addr:suburb"], t["addr:city"]].filter(Boolean).join(", ");

async function searchOsm({ niche, city, want, accept }) {
  const areaName = (city || "").split(/[-,]/)[0].trim();
  if (!areaName) throw new Error("Informe o estado ou a cidade.");

  // pede um pouco a mais porque removemos nomes repetidos
  const data = await runOverpass(buildOverpassQuery(areaName, niche, Math.min(want * 2 + 10, 300)));

  const seen = new Set();
  const out = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (!t.name) continue;
    const key = norm(t.name) + "|" + (t["addr:street"] || "");
    if (seen.has(key)) continue;
    seen.add(key);

    let website = t.website || t["contact:website"] || t.url || null;
    if (website && !/^https?:\/\//i.test(website)) website = "https://" + website;

    const item = decorate({
      id: `${el.type}/${el.id}`,
      source: "osm",
      name: t.name,
      phone: t.phone || t["contact:phone"] || t["contact:mobile"] || "",
      website,
      rating: null,
      reviews: 0,
      address: addressOf(t),
      mapsUri: "",
      category: niche,
      niche,
      city,
    });
    if (!accept(item)) continue;
    out.push(item);
    if (out.length >= want) break;
  }
  return out;
}

// ------------------------------------------------------------------ API ----

// Consulta TODAS as fontes que têm chave (Google, Foursquare, HERE, TomTom) ao mesmo tempo
// e junta o resultado (merge.js): a mesma empresa vira um card só, com os dados de todas.
// O OpenStreetMap só entra se nenhuma das outras responder. Quem falha fica 10 min em pausa.
const COOLDOWN_MS = 10 * 60 * 1000;
const cooling = {}; // provedor -> { until, error }
const ANY = () => true;

const failMsg = (e) => String(e?.message || e).replace(/\s+/g, " ").slice(0, 170);

// Filtros (aplicados ANTES de cortar a lista, pra devolver a quantidade pedida):
//   onlyNoSite: só empresas sem site cadastrado (para oferecer criação de site)
//   phone: "any" | "valid" (formato válido, sem alerta) | "mobile" (formato de celular válido)
//          | "backed" (confirmado pelo site da empresa OU o mesmo número em 2+ bases;
//            "confirmed" é o nome antigo e continua aceito)
// Formato válido NÃO prova que o número existe, é da empresa ou tem WhatsApp.
const CACHE_MS = Math.max(0, Number(process.env.SEARCH_CACHE_MINUTES ?? 360)) * 60_000;

export async function searchBusinesses(opts) {
  // A consulta às fontes não depende dos filtros do usuário, então todas as variações do
  // mesmo nicho/estado reaproveitam a mesma resposta (economiza a cota gratuita das APIs).
  // "Todos os comércios" sorteia ramos a cada busca, então não usa cache.
  const { niche, city } = opts;
  const key = `${norm(niche)}|${norm(city)}`;
  const raw = isAllCommerce(niche) ? await fetchAndMerge(opts) : await cached(key, CACHE_MS, () => fetchAndMerge(opts));
  if (raw.partial) forget(key); // alguma fonte falhou: não guarda o resultado incompleto
  return applyFilters(raw, opts);
}

function applyFilters(merged, { niche, max = 20, onlyNoSite = false, phone = "any" }) {
  const want = Math.min(Math.max(Number(max) || 20, 1), 80);
  const mode = phone === "confirmed" ? "backed" : phone;
  const accept = (b) => {
    if (onlyNoSite && b.website) return false;
    if (mode === "mobile" && b.phoneType !== "mobile") return false;
    if (mode === "valid" && !b.phoneOk) return false;
    if (mode === "backed" && !b.phoneConfirmed) return false;
    return true;
  };
  let list = merged.filter(accept);
  // mais confiança no contato primeiro, depois mais fontes; "todos os comércios" é aleatório
  list = isAllCommerce(niche)
    ? shuffle(list)
    : [...list].sort((a, b) => phoneTier(a.phoneInfo) - phoneTier(b.phoneInfo) || b.sources.length - a.sources.length);
  return list.slice(0, want);
}

async function fetchAndMerge({ niche, city }) {
  const providers = [];
  if (process.env.GOOGLE_PLACES_API_KEY) providers.push(["google", searchGoogle]);
  if (process.env.FOURSQUARE_API_KEY) providers.push(["foursquare", searchFoursquare]);
  if (process.env.HERE_API_KEY) providers.push(["here", searchHere]);
  if (process.env.TOMTOM_API_KEY) providers.push(["tomtom", searchTomTom]);

  const failures = [];
  const available = providers.filter(([name]) => {
    const c = cooling[name];
    if (c && Date.now() < c.until) {
      failures.push(`${name}: ${c.error} (em pausa)`);
      return false;
    }
    return true;
  });

  // Os filtros do usuário só valem DEPOIS de juntar as fontes (uma fonte pode revelar o site
  // que outra não tinha). Por isso pedimos tudo (sem filtro) e cortamos no fim.
  const lists = [];
  const settled = await Promise.allSettled(available.map(([, run]) => run({ niche, city, want: 100, accept: ANY })));
  settled.forEach((s, i) => {
    const name = available[i][0];
    if (s.status === "fulfilled") {
      lists.push(s.value);
    } else {
      const msg = failMsg(s.reason);
      cooling[name] = { until: Date.now() + COOLDOWN_MS, error: msg };
      console.error(`Busca via ${name} falhou:`, msg);
      failures.push(`${name}: ${msg}`);
    }
  });

  // nenhuma fonte com chave respondeu: última tentativa com o OpenStreetMap
  if (!lists.length) {
    const c = cooling.openstreetmap;
    if (c && Date.now() < c.until) {
      failures.push(`openstreetmap: ${c.error} (em pausa)`);
    } else {
      try {
        lists.push(await searchOsm({ niche, city, want: 100, accept: ANY }));
      } catch (e) {
        const msg = failMsg(e);
        cooling.openstreetmap = { until: Date.now() + COOLDOWN_MS, error: msg };
        console.error("Busca via openstreetmap falhou:", msg);
        failures.push(`openstreetmap: ${msg}`);
      }
    }
  }
  if (!lists.length) throw new Error(failures.join(" || "));

  // respondeu = sucesso, mesmo com lista vazia (os filtros podem ter descartado tudo)
  const merged = mergeBusinesses(lists, { city });
  merged.partial = failures.length > 0;
  return merged;
}
