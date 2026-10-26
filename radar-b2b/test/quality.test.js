import test from "node:test";
import assert from "node:assert/strict";
import { buildPhoneInfo, applySiteEvidence, legacyPhoneFields, phoneTier } from "../src/quality.js";
import { mergeBusinesses, matchLevel } from "../src/merge.js";
import { extractPhones } from "../src/enrich.js";

const src = (source, raw) => ({ source, raw, fetchedAt: "2026-01-01T00:00:00Z" });

test("mesmo número em 2 bases é corroborado, mas NÃO confirmado", () => {
  const i = buildPhoneInfo([src("tomtom", "(31) 3234-5678"), src("foursquare", "31 3234 5678")], { state: "Minas Gerais" });
  assert.equal(i.status, "format_valid");
  assert.equal(i.corroborated, true);
  assert.equal(i.whatsapp, "whatsapp_unverified");
  assert.equal(phoneTier(i), 1);
});

test("números diferentes: mantém um, lista o outro e avisa divergência", () => {
  const i = buildPhoneInfo([src("tomtom", "(31) 3234-5678"), src("foursquare", "(31) 98123-4567")], { state: "Minas Gerais" });
  assert.ok(i.flags.includes("phone_divergence"));
  assert.equal(i.alternatives.length, 1);
  assert.equal(i.sources.length, 1);
});

test("número válido ganha de inválido, e o inválido fica registrado", () => {
  const i = buildPhoneInfo([src("google", "99999-9999"), src("tomtom", "(31) 3234-5678")], { state: "Minas Gerais" });
  assert.equal(i.e164, "+553132345678");
  assert.equal(i.alternatives[0].status, "invalid_format");
});

test("sem telefone", () => {
  assert.equal(buildPhoneInfo([], {}).status, "none");
  assert.equal(phoneTier(buildPhoneInfo([], {})), 6);
});

test("número no site da empresa => business_confirmed; WhatsApp só se o site publica wa.me", () => {
  const base = buildPhoneInfo([src("tomtom", "(31) 98123-4567")], { state: "Minas Gerais" });
  const a = applySiteEvidence(base, { tel: ["+55 31 98123-4567"], whatsapp: [], jsonld: [], text: [] }, { url: "https://x.com.br" });
  assert.equal(a.status, "business_confirmed");
  assert.equal(a.whatsapp, "whatsapp_unverified");
  assert.equal(a.evidence[0].type, "business_website");
  const b = applySiteEvidence(base, { tel: [], whatsapp: ["5531981234567"], jsonld: [], text: [] }, { url: "https://x.com.br" });
  assert.equal(b.whatsapp, "whatsapp_published");
  assert.equal(legacyPhoneFields(b).phoneConfirmed, true);
});

test("site com OUTRO número não troca o do lead", () => {
  const base = buildPhoneInfo([src("tomtom", "(31) 3234-5678")], { state: "Minas Gerais" });
  const r = applySiteEvidence(base, { tel: ["(31) 3999-1111"], whatsapp: [], jsonld: [], text: [] }, { url: "https://x.com.br" });
  assert.equal(r.e164, "+553132345678");
  assert.equal(r.status, "format_valid");
  assert.ok(r.flags.includes("site_lists_other_numbers"));
  assert.equal(r.alternatives[0].e164, "+553139991111");
});

test("extractPhones separa tel:, wa.me, JSON-LD e texto", () => {
  const html = `<a href="tel:+553132345678">x</a><a href="https://wa.me/5531981234567?text=oi">w</a>
    <script type="application/ld+json">{"telephone":"+55 31 3234-5678"}</script><p>Ligue (31) 3234-5678</p>`;
  const f = extractPhones(html);
  assert.equal(f.tel[0], "+553132345678");
  assert.equal(f.whatsapp[0], "5531981234567");
  assert.equal(f.jsonld[0], "+55 31 3234-5678");
  assert.ok(f.text.some((t) => t.includes("3234")));
});

const biz = (source, id, name, phone, lat, lon, address = "") => ({ source, id, name, phone, lat, lon, address, website: null });

test("telefone igual NÃO junta empresas distantes (filiais da mesma rede)", () => {
  const a = biz("tomtom", "1", "Farmácia Exemplo", "(31) 3234-5678", -19.92, -43.94, "Rua A 1");
  const b = biz("foursquare", "2", "Farmácia Exemplo", "(31) 3234-5678", -19.80, -43.94, "Rua Z 99");
  assert.notEqual(matchLevel(a, b), "same");
  const out = mergeBusinesses([[a], [b]], { city: "Minas Gerais" });
  assert.equal(out.length, 2);
});

test("mesma empresa em 2 fontes junta, preserva registros originais e a origem", () => {
  const a = biz("tomtom", "1", "Barbearia Exemplo", "(31) 3234-5678", -19.9200, -43.9400, "Rua A 1");
  const b = biz("foursquare", "2", "Barbearia Exemplo", "(31) 3234-5678", -19.9201, -43.9401, "Rua A, 1");
  const [m] = mergeBusinesses([[a], [b]], { city: "Minas Gerais" });
  assert.equal(m.records.length, 2);
  assert.deepEqual(m.provenance.phone.sort(), ["foursquare", "tomtom"]);
  assert.equal(m.phoneInfo.corroborated, true);
});

test("registros da mesma fonte parecidos viram possível duplicata, sem juntar", () => {
  const a = biz("tomtom", "1", "Studio Beleza", "(31) 3234-5678", -19.92, -43.94, "Rua A 1");
  const b = biz("tomtom", "2", "Studio Beleza", "(31) 3234-9999", -19.9201, -43.9401, "Rua A 1");
  const out = mergeBusinesses([[a, b]], { city: "Minas Gerais" });
  assert.equal(out.length, 2);
  assert.ok(out[0].possibleDuplicates.length);
});
