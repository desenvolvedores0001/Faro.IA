// Cache em memória com validade (TTL) e junção de pedidos iguais em andamento.
// Só guarda SUCESSOS: se a busca falhar, a próxima tenta de novo. O cache some quando o
// servidor reinicia (no plano grátis do Render isso acontece quando ele "dorme").

const store = new Map(); // chave -> { value, until }
const inflight = new Map(); // chave -> Promise
const MAX_ENTRIES = 300;

export async function cached(key, ttlMs, producer) {
  if (ttlMs <= 0) return producer();
  const hit = store.get(key);
  if (hit && Date.now() < hit.until) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await producer();
      store.set(key, { value, until: Date.now() + ttlMs });
      if (store.size > MAX_ENTRIES) {
        const now = Date.now();
        for (const [k, v] of store) if (v.until < now) store.delete(k);
        while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
      }
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export const peek = (key) => { const h = store.get(key); return h && Date.now() < h.until ? h.value : undefined; };
export const forget = (key) => store.delete(key);
export const clearCache = () => store.clear();

/** Limita quantas tarefas pesadas rodam ao mesmo tempo (ex.: leitura de sites). */
export function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
