// Servidor único do Faro: serve o front-end (public/) E a API.
//   GET  /                                       -> front-end (public/index.html)
//   POST /api/search   { niche, city }           -> empresas + diagnóstico base
//   POST /api/enrich   { biz }                   -> diagnóstico enriquecido (site + PageSpeed)
//   POST /api/message  { biz, gaps, sellerName, tone } -> { message } (IA)
//   GET  /api/wa       ?phone=...&text=...        -> { url } (link do WhatsApp)
//   GET  /api/health
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchBusinesses } from "./src/places.js";
import { auditBusiness, leadHeat } from "./src/audit.js";
import { enrichBusiness } from "./src/enrich.js";
import { generateMessage } from "./src/message.js";
import { rateLimit } from "./src/ratelimit.js";
import { applySiteEvidence, legacyPhoneFields, phoneTier } from "./src/quality.js";
import { analyzePhone } from "./src/phone.js";
import { mailerAvailable, sendBulkEmail } from "./src/mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", 1); // atrás do proxy do Render: usa o IP real do visitante nos limites
app.use(cors());
app.use(express.json({ limit: "200kb" }));

// limites por IP (protegem a cota gratuita das APIs de empresas)
const limitSearch = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_SEARCH_PER_MIN) || 20 });
const limitEnrich = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_ENRICH_PER_MIN) || 120 });
const limitMessage = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_MESSAGE_PER_MIN) || 30 });
// envio em massa é mais sensível (gasta a cota do provedor de e-mail e pode parecer disparo):
// bem mais restrito, e cada pedido já tem um teto de destinatários (ver /api/bulk-send-email).
const limitBulkEmail = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_BULK_EMAIL_PER_MIN) || 3 });

app.post("/api/search", limitSearch, async (req, res) => {
  try {
    const { niche, city, max, onlyNoSite, phone } = req.body || {};
    if (!niche || !city) return res.status(400).json({ error: "Informe 'niche' e 'city'." });
    const businesses = await searchBusinesses({
      niche,
      city,
      max,
      onlyNoSite: Boolean(onlyNoSite),
      phone: ["any", "valid", "mobile", "backed", "confirmed"].includes(phone) ? phone : "any",
    });
    const results = businesses.map((b) => {
      const gaps = auditBusiness(b); // diagnóstico base (rápido, sem rede extra)
      return { ...b, gaps, heat: leadHeat(b, gaps) };
    });
    // contato mais confiável primeiro (confirmado pela empresa > corroborado > formato válido > com alerta >
    // inválido > sem telefone); dentro disso, mais oportunidades. ("Todos os comércios" fica aleatório.)
    const mixed = /^todos os (comercios|comércios|segmentos)$/i.test(String(niche).normalize("NFC").trim());
    if (!mixed) {
      results.sort((a, b) => phoneTier(a.phoneInfo) - phoneTier(b.phoneInfo) || b.gaps.length - a.gaps.length);
    }
    const sources = [...new Set(results.flatMap((r) => r.sources || [r.source]))];
    res.json({ results, source: results[0]?.source || null, sources });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/enrich", limitEnrich, async (req, res) => {
  try {
    const { biz, light } = req.body || {};
    if (!biz?.name) return res.status(400).json({ error: "Informe 'biz'." });
    // lê o site (e-mail, redes, WhatsApp) + PageSpeed. `light` pula o PageSpeed (varredura em lote)
    const enrichment = await enrichBusiness(biz, { light: Boolean(light) });
    const gaps = auditBusiness(biz, enrichment);
    // evidência do site: se o número do lead aparece no site da empresa, vira "confirmado pela empresa".
    // O servidor só confia na ficha que ele mesmo montou, então recalcula a partir do número bruto.
    let phoneInfo = null;
    if (biz.phoneInfo && typeof biz.phoneInfo === "object" && enrichment.checkedSite) {
      const base = sanitizePhoneInfo(biz.phoneInfo, biz.city);
      phoneInfo = applySiteEvidence(base, enrichment.sitePhones, { url: biz.website, at: enrichment.checkedAt || undefined, state: biz.city });
    }
    res.json({ enrichment, gaps, heat: leadHeat(biz, gaps), phoneInfo, ...(phoneInfo ? legacyPhoneFields(phoneInfo) : {}) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/message", limitMessage, async (req, res) => {
  try {
    const { biz, gaps = [], sellerName, about, tone } = req.body || {};
    if (!biz?.name) return res.status(400).json({ error: "Informe os dados da empresa em 'biz'." });
    // sem chave da Anthropic: o front usa os modelos de mensagem prontos (sem erro no log)
    if (!process.env.ANTHROPIC_API_KEY) return res.json({ message: null, reason: "sem ANTHROPIC_API_KEY" });
    const message = await generateMessage({ biz, gaps, sellerName, about, tone });
    res.json({ message });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Envio em massa de e-mail (mala direta dos leads selecionados). Só existe quando o usuário
// configurou uma conta de e-mail transacional (RESEND_API_KEY/RESEND_FROM ou BREVO_API_KEY/
// BREVO_FROM no Render) — sem isso, o front nem mostra o botão. Manda um a um, sequencialmente,
// e cada destinatário volta com seu próprio resultado: não existe "sucesso geral" fingido.
const MAX_BULK_EMAIL = 50;
app.post("/api/bulk-send-email", limitBulkEmail, async (req, res) => {
  try {
    if (!mailerAvailable()) return res.status(503).json({ error: "Nenhum serviço de e-mail configurado (RESEND_API_KEY ou BREVO_API_KEY)." });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "Informe 'items' (lista de {to, subject, text})." });
    if (items.length > MAX_BULK_EMAIL) return res.status(400).json({ error: `No máximo ${MAX_BULK_EMAIL} e-mails por envio.` });
    const clean = items.map((it) => ({
      to: String(it?.to || "").trim(),
      subject: String(it?.subject || "Oportunidade para sua empresa").slice(0, 200),
      text: String(it?.text || "").slice(0, 5000),
    }));
    const results = await sendBulkEmail(clean);
    res.json({ results, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Só gera o link de conversa (nada é enviado). Abrir o link NÃO prova que o número tem WhatsApp.
app.get("/api/wa", (req, res) => {
  const a = analyzePhone(req.query.phone);
  if (!a.formatValid || a.type !== "mobile") return res.status(422).json({ error: "Número sem formato de celular válido.", reasons: a.reasons });
  const url = `https://wa.me/${a.e164.slice(1)}?text=${encodeURIComponent(String(req.query.text || ""))}`;
  res.json({ url, note: "link de conversa; não confirma que o número tem WhatsApp" });
});

// O navegador manda a ficha de volta no /api/enrich; reanalisa o número em vez de confiar no status enviado.
function sanitizePhoneInfo(info, state) {
  const a = analyzePhone(info.raw, { state });
  return {
    raw: String(info.raw || ""), e164: a.e164, national: a.national, type: a.type, ddd: a.ddd, status: a.status,
    reasons: a.reasons, flags: [...new Set([...a.flags, ...(Array.isArray(info.flags) ? info.flags.filter((f) => f === "phone_divergence" || f === "corroborated") : [])])],
    corroborated: Boolean(info.corroborated) && a.formatValid, whatsapp: "whatsapp_unverified",
    sources: Array.isArray(info.sources) ? info.sources.slice(0, 6) : [], evidence: [],
    alternatives: Array.isArray(info.alternatives) ? info.alternatives.slice(0, 6) : [],
    lastCheckedAt: info.lastCheckedAt || null, sourceUpdatedAt: info.sourceUpdatedAt || null,
  };
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Config pública que o front usa para ligar no Supabase (chaves públicas; o
// acesso aos dados é protegido por Row Level Security no banco). Se não houver
// Supabase configurado, o front cai no "modo local" (leads no navegador).
app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    bulkEmail: mailerAvailable(),
  });
});

// front-end
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Faro rodando em http://localhost:${PORT}`));
