import test from "node:test";
import assert from "node:assert/strict";

async function freshMailer(env) {
  for (const k of ["RESEND_API_KEY", "RESEND_FROM", "BREVO_API_KEY", "BREVO_FROM"]) delete process.env[k];
  Object.assign(process.env, env);
  return import("../src/mailer.js?t=" + Math.random());
}

test("sem provedor configurado: indisponível e nenhum envio fingido", async () => {
  const { mailerAvailable, sendBulkEmail } = await freshMailer({});
  assert.equal(mailerAvailable(), false);
  const [r] = await sendBulkEmail([{ to: "a@b.com", subject: "x", text: "y" }], { delayMs: 0 });
  assert.equal(r.ok, false);
});

test("e-mail inválido nunca chega a chamar o provedor", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const { sendBulkEmail } = await freshMailer({ RESEND_API_KEY: "k", RESEND_FROM: "faro@example.com" });
  const [r] = await sendBulkEmail([{ to: "não-é-email", subject: "x", text: "y" }], { delayMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("Resend: envia e reporta sucesso/falha por destinatário", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body));
    const to = JSON.parse(opts.body).to[0];
    return to === "falha@x.com" ? { ok: false, status: 422, text: async () => "erro" } : { ok: true, json: async () => ({ id: "1" }) };
  };
  const { sendBulkEmail } = await freshMailer({ RESEND_API_KEY: "k", RESEND_FROM: "faro@example.com" });
  const results = await sendBulkEmail(
    [{ to: "ok@x.com", subject: "s1", text: "t1" }, { to: "falha@x.com", subject: "s2", text: "t2" }],
    { delayMs: 0 }
  );
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(calls[0].from, "faro@example.com");
});

test("sem RESEND_FROM: erro claro em vez de mandar sem remetente", async () => {
  const { sendBulkEmail } = await freshMailer({ RESEND_API_KEY: "k" });
  const [r] = await sendBulkEmail([{ to: "a@b.com", subject: "x", text: "y" }], { delayMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.error, /RESEND_FROM/);
});
