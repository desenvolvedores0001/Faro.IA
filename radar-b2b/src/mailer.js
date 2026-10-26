// Envio de e-mail em massa (mala direta) pelos leads selecionados. Usa a conta de e-mail
// transacional que O USUÁRIO cria (grátis, limites baixos) — o Faro nunca manda e-mail
// em nome de ninguém sem essa chave configurada, e nunca inventa remetente.
//   RESEND_API_KEY + RESEND_FROM   (resend.com, grátis até ~100/dia / 3000/mês no plano free)
//   ou BREVO_API_KEY + BREVO_FROM  (brevo.com, grátis até 300/dia)
// Se nenhuma estiver configurada, o envio em massa fica desativado (sem inventar sucesso).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function provider() {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.BREVO_API_KEY) return "brevo";
  return null;
}

export function mailerAvailable() {
  return Boolean(provider());
}

async function sendOne({ to, subject, text }) {
  if (!EMAIL_RE.test(String(to || ""))) return { to, ok: false, error: "e-mail inválido" };
  const p = provider();
  try {
    if (p === "resend") {
      const from = process.env.RESEND_FROM;
      if (!from) return { to, ok: false, error: "RESEND_FROM não configurado" };
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { to, ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
      return { to, ok: true };
    }
    if (p === "brevo") {
      const from = process.env.BREVO_FROM;
      if (!from) return { to, ok: false, error: "BREVO_FROM não configurado" };
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ sender: { email: from }, to: [{ email: to }], subject, textContent: text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { to, ok: false, error: `Brevo ${res.status}: ${(await res.text()).slice(0, 200)}` };
      return { to, ok: true };
    }
    return { to, ok: false, error: "nenhum serviço de e-mail configurado" };
  } catch (e) {
    return { to, ok: false, error: String(e.message || e) };
  }
}

/**
 * Manda um a um, com uma pequena pausa entre cada (gentil com a cota grátis do provedor e
 * evita que um lote grande pareça disparo de spam). Para no primeiro item sem destinatário
 * e segue adiante nos outros mesmo se um falhar — cada resultado é reportado individualmente.
 * @param {{to:string, subject:string, text:string}[]} items
 */
export async function sendBulkEmail(items, { delayMs = 350 } = {}) {
  const out = [];
  for (const item of items) {
    out.push(await sendOne(item));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}
