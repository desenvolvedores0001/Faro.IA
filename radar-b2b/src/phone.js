// Valida o FORMATO de telefones brasileiros e diz se parece celular (WhatsApp provável)
// ou fixo. Não prova que o número existe nem que é da empresa: só descarta lixo óbvio
// (DDD que não existe, tamanho errado, dígitos repetidos).

const DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

// DDDs de cada estado (nome sem acento, minúsculo). Serve pra descartar telefone de outro estado.
const STATE_DDD = {
  acre: [68], alagoas: [82], amapa: [96], amazonas: [92, 97], bahia: [71, 73, 74, 75, 77],
  ceara: [85, 88], "distrito federal": [61], "espirito santo": [27, 28], goias: [62, 64],
  maranhao: [98, 99], "mato grosso": [65, 66], "mato grosso do sul": [67],
  "minas gerais": [31, 32, 33, 34, 35, 37, 38], para: [91, 93, 94], paraiba: [83],
  parana: [41, 42, 43, 44, 45, 46], pernambuco: [81, 87], piaui: [86, 89],
  "rio de janeiro": [21, 22, 24], "rio grande do norte": [84], "rio grande do sul": [51, 53, 54, 55],
  rondonia: [69], roraima: [95], "santa catarina": [47, 48, 49],
  "sao paulo": [11, 12, 13, 14, 15, 16, 17, 18, 19], sergipe: [79], tocantins: [63],
};

/** true se o DDD pertence ao estado (ou se o "estado" não é um estado conhecido). */
export function dddMatchesState(ddd, state) {
  const key = String(state || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[-,]/)[0]
    .trim();
  const list = STATE_DDD[key];
  return list ? list.includes(Number(ddd)) : true;
}

const STATE_OF_DDD = {};
for (const [st, list] of Object.entries(STATE_DDD)) for (const d of list) STATE_OF_DDD[d] = st;
export const stateOfDdd = (ddd) => STATE_OF_DDD[Number(ddd)] || null;

// Números que NÃO são de um telefone comum: 0800/0300/0500/0900 e 4003/4004/4020 (central de atendimento).
const SERVICE = /^(0?800|0?300|0?500|0?900)\d{6,7}$|^(4003|4004|4020|3003)\d{4}$/;

const reject = (raw, reason, extra = {}) => ({
  raw: String(raw ?? ""), e164: "", national: "", ddd: null, type: null,
  formatValid: false, status: "invalid_format", flags: [], reasons: [reason], ...extra,
});

/**
 * Analisa o FORMATO de um telefone brasileiro. Nunca "conserta" números (não adivinha DDD nem
 * o 9º dígito) e não prova que o número existe, é da empresa ou tem WhatsApp.
 * @param {string} raw     telefone como veio da fonte (guardado em `raw` para auditoria)
 * @param {{state?:string}} opts  estado da busca: DDD de outro estado vira sinal de alerta
 * @returns {{raw:string,e164:string,national:string,ddd:number|null,type:"mobile"|"landline"|"service"|null,
 *   formatValid:boolean,status:"invalid_format"|"unverified"|"format_valid",flags:string[],reasons:string[]}}
 */
export function analyzePhone(raw, { state } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return reject(raw, "empty");
  // mais de um número no mesmo campo ("3333-4444 / 3333-5555"): não adivinha qual é qual
  if (/[\/;|]| ou |,/.test(text) && (text.match(/\d{4,}/g) || []).length > 2) return reject(raw, "multiple_numbers");
  if (/[a-z]{3,}/i.test(text.replace(/\b(ramal|r|tel|fone|whats(app)?)\b/gi, ""))) return reject(raw, "has_letters");

  let d = text.replace(/ramal.*$/i, "").replace(/\D/g, "");
  if (!d) return reject(raw, "no_digits");
  if (SERVICE.test(d)) {
    const n = d.replace(/^0/, "");
    return { raw: text, e164: "", national: n, ddd: null, type: "service", formatValid: true, status: "format_valid", flags: ["service_number"], reasons: [] };
  }
  if (d.startsWith("0055")) d = d.slice(4);
  else if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.startsWith("0") && (d.length === 11 || d.length === 12)) d = d.slice(1); // 0 de tronco: 011 99999-9999
  if (d.length < 8) return reject(raw, "too_short");
  if (d.length === 8 || d.length === 9) return reject(raw, "missing_ddd"); // sem DDD: não chutamos
  if (d.length !== 10 && d.length !== 11) return reject(raw, d.length < 10 ? "too_short" : "too_long");

  const ddd = Number(d.slice(0, 2));
  const local = d.slice(2);
  if (!DDD.has(ddd)) return reject(raw, "unknown_ddd", { ddd });
  if (/^(\d)\1+$/.test(local)) return reject(raw, "repeated_digits", { ddd });
  if (/^(0123456|1234567|2345678|3456789|9876543|8765432|7654321)/.test(local.replace(/^9/, "")) || /^(12345678|87654321)$/.test(local.slice(-8))) return reject(raw, "sequential_digits", { ddd });
  if (/^(\d{2})\1{3,}$/.test(local.slice(-8))) return reject(raw, "repeated_pattern", { ddd });

  let type;
  if (d.length === 11) {
    if (local[0] !== "9") return reject(raw, "mobile_must_start_with_9", { ddd });
    type = "mobile";
  } else if (/[2-5]/.test(local[0])) {
    type = "landline";
  } else {
    // 10 dígitos começando em 6-9: formato antigo de celular (sem o 9º dígito). Não completamos.
    return reject(raw, "legacy_mobile_without_9", { ddd });
  }

  const flags = [];
  const reasons = [];
  if (state && !dddMatchesState(ddd, state)) {
    flags.push("ddd_other_state");
    reasons.push("ddd_other_state");
  }
  const national = d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return {
    raw: text, e164: "+55" + d, national, ddd, type, formatValid: true,
    status: flags.length ? "unverified" : "format_valid", flags, reasons,
  };
}

/** Compatibilidade: só o formato (sem olhar o estado). */
export function parsePhone(raw) {
  const a = analyzePhone(raw);
  const ok = a.formatValid && (a.type === "mobile" || a.type === "landline");
  return ok ? { valid: true, type: a.type, e164: a.e164, ddd: a.ddd } : { valid: false, type: null, e164: "" };
}

/** Os 8 últimos dígitos: comparam o "mesmo número" mesmo escrito de jeitos diferentes. */
export const phoneKey = (raw) => String(raw || "").replace(/\D/g, "").slice(-8);
