'use strict';
const { DETECTORS, TYPES } = require('./detectors');
const { generate } = require('./surrogates');

function normKey(type, value) {
  let v = value.trim();
  if (['DNI', 'CIF', 'IBAN', 'MATRICULA', 'TARJETA', 'TELEFONO'].includes(type)) {
    v = v.replace(/[\s.-]/g, '').toUpperCase();
    if (type === 'TELEFONO') v = v.replace(/^(\+34|0034)/, '');
  } else {
    v = v.replace(/\s+/g, ' ').toLowerCase();
  }
  return `${type}:${v}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sesión: mantiene el mapa valor⇄marcador para que el mismo dato siempre reciba el mismo marcador. */
class Session {
  /** mode: 'marcadores' ([DNI_1]) | 'realista' (datos falsos verosímiles) | 'irreversible' ([DNI], sin guardar nada) */
  constructor(data) {
    this.items = []; // {placeholder, type, value}; placeholder = texto de sustitución
    this.byKey = new Map();
    this.counters = {};
    this.used = new Set();
    this.mode = (data && data.mode) || 'marcadores';
    this.dateOffset = (data && data.dateOffset) || (30 + Math.floor(Math.random() * 370)) * (Math.random() < 0.5 ? -1 : 1);
    if (data && Array.isArray(data.items)) {
      for (const it of data.items) this._register(it.type, it.value, it.placeholder);
    }
  }

  _register(type, value, placeholder) {
    // un mismo dato puede tener marcador y sustituto realista (si se cambia de modo en la misma sesión): cada modo usa el suyo
    const base = normKey(type, value);
    const isMarker = (p) => /^\[[A-Z]+_\d+\]$/.test(p);
    if (!placeholder) {
      const real = this.mode === 'realista';
      const hit = real ? this.byKey.get('r|' + base) : this.byKey.get('m|' + base);
      if (hit) return hit;
      if (real) {
        placeholder = this._surrogate(type, value);
        // tipos sin sustituto realista usan marcador (y se reutiliza el que ya exista)
        if (!placeholder && this.byKey.has('m|' + base)) return this.byKey.get('m|' + base);
      }
    }
    if (!placeholder) {
      const n = (this.counters[type] || 0) + 1;
      this.counters[type] = n;
      placeholder = `[${type}_${n}]`;
    } else {
      const m = /^\[([A-Z]+)_(\d+)\]$/.exec(placeholder);
      if (m) this.counters[m[1]] = Math.max(this.counters[m[1]] || 0, Number(m[2]));
    }
    this.used.add(placeholder.toLowerCase());
    const item = { placeholder, type, value };
    this.items.push(item);
    this.byKey.set((isMarker(placeholder) ? 'm|' : 'r|') + base, item);
    return item;
  }

  _surrogate(type, value) {
    for (let i = 0; i < 25; i++) {
      const s = generate(type, value, { dateOffset: this.dateOffset });
      if (!s) return null;
      if (s.toLowerCase() !== value.toLowerCase() && !this.used.has(s.toLowerCase())) return s;
    }
    return null;
  }

  placeholderFor(type, value) {
    if (this.mode === 'irreversible') return `[${type}]`;
    return this._register(type, value).placeholder;
  }

  toJSON() {
    return { version: 2, mode: this.mode, dateOffset: this.dateOffset, items: this.items };
  }

  get size() {
    return this.items.length;
  }
}

/**
 * Detecta datos personales. Devuelve coincidencias sin solapes, ordenadas por posición.
 * opts.enabled: {TIPO: bool}; opts.custom: [{term, type}]
 */
function detect(text, opts = {}) {
  const enabled = opts.enabled || {};
  const on = (type) => (type in enabled ? !!enabled[type] : TYPES.find((t) => t.type === type)?.defaultOn !== false);
  const cands = [];

  for (const d of DETECTORS) {
    if (!on(d.type)) continue;
    d.re.lastIndex = 0;
    let m;
    while ((m = d.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        d.re.lastIndex++;
        continue;
      }
      let value = m[0];
      let start = m.index;
      // recorta puntuación final pegada
      const trimmed = value.replace(/[\s.,;:]+$/, (s) => (d.type === 'EMPRESA' && /\.$/.test(s) ? '.' : ''));
      if (trimmed !== value) value = trimmed;
      if (d.validate && !d.validate(value)) continue;
      cands.push({ type: d.type, value, start, end: start + value.length, priority: d.priority });
    }
  }

  for (const c of opts.custom || []) {
    const term = (c.term || '').trim();
    if (!term) continue;
    const re = new RegExp(`(?<![\\p{L}\\d])${escapeRe(term)}(?![\\p{L}\\d])`, 'giu');
    let m;
    while ((m = re.exec(text)) !== null) {
      cands.push({ type: c.type || 'PERSONALIZADO', value: m[0], start: m.index, end: m.index + m[0].length, priority: 200, custom: true });
    }
  }

  cands.sort((a, b) => b.priority - a.priority || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken = [];
  for (const c of cands) {
    if (!taken.some((t) => c.start < t.end && c.end > t.start)) taken.push(c);
  }
  taken.sort((a, b) => a.start - b.start);
  return taken.map((c, i) => ({ id: i, type: c.type, value: c.value, start: c.start, end: c.end, custom: !!c.custom }));
}

/** Aplica las coincidencias (ya filtradas por el usuario) y devuelve el texto anonimizado. */
function apply(text, matches, session) {
  return segments(text, matches, session)
    .map((s) => s.t)
    .join('');
}

/** Igual que apply, pero devuelve trozos: [{t}] texto sin tocar, [{t, type, value}] dato sustituido (para resaltarlo en pantalla). */
function segments(text, matches, session) {
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const out = [];
  let pos = 0;
  for (const m of sorted) {
    if (m.start < pos) continue;
    if (m.start > pos) out.push({ t: text.slice(pos, m.start) });
    out.push({ t: session.placeholderFor(m.type, m.value), type: m.type, value: m.value });
    pos = m.end;
  }
  if (pos < text.length) out.push({ t: text.slice(pos) });
  return out;
}

function anonymize(text, session, opts) {
  const matches = detect(text, opts);
  return { text: apply(text, matches, session), matches };
}

/** Restaura los datos reales. Tolera que la IA quite corchetes o cambie mayúsculas. */
function restore(text, session) {
  if (!session.items.length) return { text, restored: 0, unknown: [] };
  const isMark = (it) => /^\[[A-Z]+_\d+\]$/.test(it.placeholder);
  const marks = session.items.filter(isMark);
  const sur = session.items.filter((it) => !isMark(it));
  const byLower = new Map(marks.map((it) => [it.placeholder.slice(1, -1).toLowerCase(), it]));
  const bySur = new Map(sur.map((it) => [it.placeholder.toLowerCase(), it]));
  const alt = (arr) => arr.sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const mk = alt([...byLower.keys()]);
  const sk = alt([...bySur.keys()]);
  const parts = [];
  if (mk) parts.push(`\\[\\s*(${mk})\\s*\\]`, `(?<![\\p{L}\\d_])(${mk})(?![\\p{L}\\d_])`);
  if (sk) parts.push(`(?<![\\p{L}\\d])(${sk})(?![\\p{L}\\d])`);
  const re = new RegExp(parts.join('|'), 'giu');
  let restored = 0;
  const out = text.replace(re, (...args) => {
    const g = args.slice(1, 4).find((x) => typeof x === 'string');
    const key = g.toLowerCase();
    const it = byLower.get(key) || bySur.get(key);
    restored++;
    return it.value;
  });
  const known = new Set(marks.map((i) => i.placeholder));
  const unknown = [...new Set((out.match(/\[[A-Z]+_\d+\]/g) || []).filter((p) => !known.has(p)))];
  return { text: out, restored, unknown };
}

/** Comprobación de fugas: ¿queda algún valor real en el texto "anonimizado"? */
function leakCheck(text, session) {
  const leaks = [];
  const low = text.toLowerCase();
  for (const it of session.items) {
    if (it.value.length >= 3 && low.includes(it.value.toLowerCase())) leaks.push({ type: it.type, value: it.value });
  }
  return leaks;
}

/** Fugas contra los valores detectados (sirve también en modo irreversible, donde no hay sesión). */
function leakCheckValues(text, matches) {
  const low = text.toLowerCase();
  const seen = new Set();
  return matches
    .filter((m) => m.value.length >= 3 && low.includes(m.value.toLowerCase()) && !seen.has(m.value.toLowerCase()) && seen.add(m.value.toLowerCase()))
    .map((m) => ({ type: m.type, value: m.value }));
}

function summarize(matches) {
  const counts = {};
  for (const m of matches) counts[m.type] = (counts[m.type] || 0) + 1;
  return counts;
}

module.exports = { Session, detect, apply, segments, anonymize, restore, leakCheck, leakCheckValues, summarize, normKey };
