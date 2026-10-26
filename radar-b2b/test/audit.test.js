import test from "node:test";
import assert from "node:assert/strict";
import { auditBusiness } from "../src/audit.js";

// Cenários que disparam todos os gaps possíveis do servidor.
const cases = [
  auditBusiness({ name: "X", city: "Bahia", niche: "Barbearia", source: "tomtom", sources: ["tomtom", "here"] }),
  auditBusiness({ name: "X", city: "Bahia", niche: "Barbearia", source: "google" }),
  auditBusiness({ name: "X", website: "http://x.com.br" }, { mobileScore: 0.3, whatsapp: false, instagram: false }),
  auditBusiness({ name: "X", website: "https://x.com.br" }, { mobileScore: 0.6 }),
].flat();

test("todo gap traz as peças da mensagem", () => {
  assert.ok(cases.length >= 6);
  for (const g of cases) for (const k of ["pain", "impact", "solution", "service"]) assert.ok(g[k], `${g.title}: falta ${k}`);
});

test("as peças se encaixam nas frases sem quebrar a gramática", () => {
  for (const g of cases) {
    // completa "notei que ___": começa minúscula e não fecha a frase
    assert.match(g.pain, /^[a-zà-ú]/, g.pain);
    assert.doesNotMatch(g.pain, /[.!?]$/, g.pain);
    // frase completa
    assert.match(g.impact, /^[A-ZÀ-Ú].*\.$/, g.impact);
    // completa "posso ajudar a ___" / "trabalho com ___"
    assert.match(g.solution, /^[a-zà-ú]+r\b/, g.solution);
    assert.match(g.service, /^[a-zà-ú]/, g.service);
  }
});

test('"Trabalho com X e posso Y" não repete palavra nem empilha "e"', () => {
  const stems = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/)
    .filter((w) => w.length > 4 && !/^sites?$/.test(w)).map((w) => w.slice(0, 5));
  for (const g of cases) {
    const shared = stems(g.service).filter((w) => stems(g.solution).includes(w));
    assert.deepEqual(shared, [], `${g.service} / ${g.solution}`);
    const frase = `trabalho com ${g.service} e posso ${g.solution}`;
    assert.ok((frase.match(/ e /g) || []).length <= 2, frase);
  }
});

test("sem gírias, aspas, travessão ou primeira pessoa solta no texto da mensagem", () => {
  for (const g of cases) {
    const t = [g.pain, g.impact, g.solution, g.service].join(" ");
    assert.doesNotMatch(t, /\b(pra|pro|tá|vc|aí)\b|["“”—]/i, t);
    assert.doesNotMatch(g.pain, /^(não )?(achei|encontrei|vi)\b/i, g.pain); // "notei que não encontrei" é erro
  }
});
