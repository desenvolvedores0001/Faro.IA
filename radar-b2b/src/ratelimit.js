// Limite simples de pedidos por IP (janela fixa), sem dependências. Protege as cotas gratuitas
// das APIs de empresas e o servidor. Em memória: reinicia junto com o servidor.

export function rateLimit({ windowMs = 60_000, max = 30, message = "Muitos pedidos em pouco tempo. Aguarde um instante e tente de novo." } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref?.();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || "?";
    let h = hits.get(key);
    if (!h || h.resetAt <= now) hits.set(key, (h = { count: 0, resetAt: now + windowMs }));
    h.count++;
    res.set("RateLimit-Remaining", String(Math.max(0, max - h.count)));
    if (h.count > max) {
      res.set("Retry-After", String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
