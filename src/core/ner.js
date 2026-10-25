'use strict';
// Detección de nombres de persona con un modelo local (BERT multilingüe, formato ONNX). Funciona sin red: el modelo se descarga una vez, a petición del usuario.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { inElectronMain, runInChild } = require('./child');

// versión fijada del modelo + huella SHA-256 de cada archivo: si algo cambia o llega truncado, la descarga se rechaza
const SHA = {
  'config.json': '7aa891abae067f95a40f5e2005b3de44824a083f256802934a993d301ec25076',
  'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
  'tokenizer.json': 'bf1b59b7b11c95f194f51708d918eea378e09d05f84c0e1656dc5180e8117088',
  'tokenizer_config.json': 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
  'vocab.txt': 'fe0fda7c425b48c516fc8f160d594c8022a0808447475c1a7c6d6479763f310c',
  'onnx/model_quantized.onnx': '5b65139844be260b624a2a13782b01d122e613d64ce16ed0ba4d82e0b816f1a9'
};
const FILES = Object.keys(SHA);
const BASE = 'https://huggingface.co/Xenova/bert-base-multilingual-cased-ner-hrl/resolve/263e82c06569c8c2ac46238a7ae5107598934234/';
const MODEL_BYTES = 178495423;

const modelPath = (dir) => path.join(dir, 'ner');
const installed = (dir) => FILES.every((f) => fs.existsSync(path.join(modelPath(dir), f)));

let pipe = null;
let pipeDir = null;
async function getPipe(dir) {
  if (pipe && pipeDir === dir) return pipe;
  const tf = await import('@huggingface/transformers');
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = dir + path.sep;
  pipe = await tf.pipeline('token-classification', 'ner', { dtype: 'q8', device: 'cpu' });
  pipeDir = dir;
  return pipe;
}

const CHUNK = 1200;
/** Nombres de persona (únicos) encontrados en el texto. */
async function findNamesInline(text, dir) {
  const p = await getPipe(dir);
  const names = new Set();
  for (let i = 0; i < text.length; i += CHUNK) {
    const part = text.slice(i, i + CHUNK + 100);
    if (part.trim().length < 3) continue;
    const res = await p(part, { aggregation_strategy: 'simple' });
    for (const r of res) {
      if (!/PER/.test(r.entity_group || r.entity || '') || r.score < 0.85) continue;
      const w = String(r.word).replace(/\s+/g, ' ').replace(/^[^\p{L}]+|[^\p{L}.]+$/gu, '').trim();
      if (w.length >= 3 && /\p{L}{2}/u.test(w)) names.add(w);
    }
  }
  return [...names];
}

// el nombre puede aparecer partido en dos líneas o con varios espacios: cualquier hueco en blanco vale
const escapeRe = (s) => s.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');

/** Coincidencias PERSONA que el modelo encuentra y que no solapan con las ya detectadas. */
async function nerMatches(text, dir, existing = []) {
  if (!dir || !installed(dir) || text.trim().length < 3) return [];
  let names;
  try {
    names = inElectronMain() ? await runInChild('ner', [text, dir], 180000) : await findNamesInline(text, dir);
  } catch (err) {
    throw new Error('El modelo de nombres falló (' + err.message + '). Desactívalo en Ajustes o vuelve a descargarlo.');
  }
  const out = [];
  for (const n of names) {
    const re = new RegExp('(?<![\\p{L}\\d])' + escapeRe(n) + '(?![\\p{L}\\d])', 'gu');
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if ([...existing, ...out].some((o) => start < o.end && end > o.start)) continue;
      out.push({ type: 'PERSONA', value: m[0], start, end });
    }
  }
  return out;
}

/** Descarga el modelo a dir (solo hosts de Hugging Face, por https). onProgress(bytesHechos, bytesTotales). */
async function download(dir, onProgress) {
  const total = MODEL_BYTES + 4_000_000;
  let done = 0;
  const root = modelPath(dir);
  for (const f of FILES) {
    const dest = path.join(root, f);
    if (fs.existsSync(dest)) {
      done += fs.statSync(dest).size;
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(BASE + f, { redirect: 'follow' });
    if (!res.ok || !/^https:\/\/([\w-]+\.)*(huggingface\.co|hf\.co)\//.test(res.url)) throw new Error('Descarga rechazada: ' + f);
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      out.write(value);
      done += value.length;
      if (onProgress) onProgress(done, total);
    }
    await new Promise((r) => out.end(r));
    const sum = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
    if (sum !== SHA[f]) {
      fs.rmSync(tmp, { force: true });
      throw new Error('El archivo ' + f + ' llegó incompleto o distinto al esperado');
    }
    fs.renameSync(tmp, dest);
  }
  return installed(dir);
}

module.exports = { installed, nerMatches, findNamesInline, download, MODEL_BYTES };
