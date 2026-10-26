import test from "node:test";
import assert from "node:assert/strict";
import { analyzePhone } from "../src/phone.js";

// Números sintéticos só para testar regras de formato (não são dados do produto).
test("celular e fixo válidos viram E.164", () => {
  const m = analyzePhone("(31) 98123-4567", { state: "Minas Gerais" });
  assert.equal(m.status, "format_valid");
  assert.equal(m.type, "mobile");
  assert.equal(m.e164, "+5531981234567");
  const l = analyzePhone("+55 31 3234-5678", { state: "Minas Gerais" });
  assert.equal(l.type, "landline");
  assert.equal(l.e164, "+553132345678");
  assert.equal(analyzePhone("031 3234-5678").e164, "+553132345678");
});

test("guarda o texto original para auditoria", () => {
  assert.equal(analyzePhone(" (31) 3234-5678 ").raw, "(31) 3234-5678");
});

test("formatos impossíveis são invalid_format com motivo", () => {
  const cases = {
    "3234-5678": "missing_ddd",
    "(00) 98123-4567": "unknown_ddd",
    "(31) 99999-9999": "repeated_digits",
    "(31) 8123-4567": "legacy_mobile_without_9",
    "(31) 88123-4567": "mobile_must_start_with_9",
    "1234": "too_short",
    "(31) 3234-5678 / (31) 3234-9999": "multiple_numbers",
    "": "empty",
    "(31) 12345678": "sequential_digits",
  };
  for (const [raw, reason] of Object.entries(cases)) {
    const r = analyzePhone(raw);
    assert.equal(r.status === "invalid_format" ? r.reasons[0] : r.status, reason, raw);
    assert.equal(r.e164, "", raw);
  }
});

test("DDD de outro estado não é aceito como confiável", () => {
  const r = analyzePhone("(82) 3324-6824", { state: "São Paulo" });
  assert.equal(r.formatValid, true);
  assert.equal(r.status, "unverified");
  assert.deepEqual(r.flags, ["ddd_other_state"]);
});

test("0800 é número de serviço, sem WhatsApp", () => {
  const r = analyzePhone("0800 123 4567");
  assert.equal(r.type, "service");
  assert.equal(r.e164, "");
});

test("nunca inventa DDD nem 9º dígito", () => {
  assert.equal(analyzePhone("98123-4567").status, "invalid_format");
  assert.equal(analyzePhone("(31) 8123-4567").e164, "");
});
