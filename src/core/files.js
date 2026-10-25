'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { detect, apply, restore, summarize } = require('./anonymizer');
const { nerMatches } = require('./ner');
const { redactPdf, redactImage } = require('./redact');

const { anonymizeDocx, anonymizeXlsx, restoreOoxml } = require('./ooxml');
const os = require('os');

/** Tapa datos en una imagen incrustada (OCR); devuelve el mismo formato (PNG o JPEG). */
function embeddedImage(opts) {
  return async (buf, ext) => {
    const tmp = path.join(os.tmpdir(), 'anoni-' + crypto.randomBytes(6).toString('hex'));
    fs.writeFileSync(tmp + ext, buf);
    try {
      const r = await redactImage(tmp + ext, opts, tmp + '.png');
      if (!r.total) return r;
      let out = fs.readFileSync(tmp + '.png');
      if (/jpe?g/i.test(ext)) {
        const { loadImage, createCanvas } = require('@napi-rs/canvas');
        const img = await loadImage(out);
        const c = createCanvas(img.width, img.height);
        c.getContext('2d').drawImage(img, 0, 0);
        out = c.toBuffer('image/jpeg', 90);
      }
      return { ...r, buf: out };
    } finally {
      fs.rmSync(tmp + ext, { force: true });
      fs.rmSync(tmp + '.png', { force: true });
    }
  };
}

const IMAGES = ['.png', '.jpg', '.jpeg'];
const SUPPORTED = ['.txt', '.md', '.csv', '.json', '.docx', '.xlsx', '.pdf', ...IMAGES];

function isSupported(file) {
  return SUPPORTED.includes(path.extname(file).toLowerCase());
}

async function readPdfText(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    let line = '';
    let lastY = null;
    const lines = [];
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = '';
      }
      line += it.str + (it.hasEOL ? '\n' : '');
      lastY = y;
    }
    lines.push(line);
    pages.push(lines.join('\n'));
  }
  return pages.join('\n\n');
}

/** Texto oculto en un PDF: fuente minúscula o fuera de la página (típico de inyección de instrucciones a la IA). */
async function scanPdfHidden(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const found = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [x0, y0, x1, y1] = page.view;
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const [a, , , d, x, y] = it.transform;
      const size = Math.max(Math.abs(a), Math.abs(d));
      const reason = size < 2 ? 'fuente diminuta' : x < x0 - 5 || x > x1 + 5 || y < y0 - 5 || y > y1 + 5 ? 'fuera de la página' : null;
      if (reason) found.push({ page: p, reason, text: it.str.trim().slice(0, 120) });
    }
  }
  return found;
}

/** Lee un archivo y devuelve su texto plano. */
async function readText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    return (await mammoth.extractRawText({ path: file })).value;
  }
  if (ext === '.pdf') return readPdfText(file);
  if (ext === '.xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const parts = [];
    wb.eachSheet((ws) => {
      parts.push(`# ${ws.name}`);
      ws.eachRow((row) => parts.push(row.values.slice(1).map(cellText).join('\t')));
    });
    return parts.join('\n');
  }
  return fs.readFileSync(file, 'utf8');
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v);
}

function outPath(file, outDir, suffix, forceExt) {
  const ext = forceExt || path.extname(file);
  const base = path.basename(file, path.extname(file));
  return path.join(outDir || path.dirname(file), `${base}${suffix}${ext}`);
}

async function writeDocx(text, dest) {
  const { Document, Packer, Paragraph, TextRun } = require('docx');
  const paras = text.split(/\r?\n/).map((l) => new Paragraph({ children: [new TextRun(l)] }));
  const doc = new Document({
    creator: 'Disfraz',
    title: '',
    description: '',
    sections: [{ children: paras }]
  });
  fs.writeFileSync(dest, await Packer.toBuffer(doc));
}

/**
 * Anonimiza un archivo y escribe la copia (original intacto).
 * xlsx se procesa celda a celda y conserva el formato; docx/pdf salen como .docx limpio (sin metadatos).
 */
async function processFile(file, session, opts, outDir) {
  const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const r = await processOne(file, session, opts || {}, outDir);
  return { ...r, sha256: sha256(file), sha256Out: sha256(r.dest), mode: r.redacted ? (r.substituted ? session.mode : 'tachado') : session.mode };
}

/** Valores que se anonimizarían en un archivo no PDF (para revisarlos antes): [{type, value, count}]. */
async function listDetections(file, opts) {
  const text = await readText(file);
  const ms = detect(text, opts);
  if (opts.nerDir) ms.push(...(await nerMatches(text, opts.nerDir, ms)));
  const by = new Map();
  for (const m of ms) {
    const k = m.type + '|' + m.value;
    by.set(k, { type: m.type, value: m.value, key: k, count: (by.get(k) ? by.get(k).count : 0) + 1 });
  }
  return [...by.values()];
}

async function processOne(file, session, opts, outDir) {
  const ext = path.extname(file).toLowerCase();
  if (opts.skips) opts = { ...opts, skip: opts.skips[file] || [], skips: undefined };
  const suffix = opts.suffix || '.anonimo';
  if (IMAGES.includes(ext)) {
    const dest = outPath(file, outDir, suffix, '.png');
    const r = await redactImage(file, opts, dest);
    return { file, dest, ...r, redacted: true };
  }
  if (ext === '.pdf' && opts.pdfMode !== 'texto') {
    const dest = outPath(file, outDir, suffix);
    const hidden = await scanPdfHidden(file).catch(() => []);
    const { newItems = [], ...r } = await redactPdf(file, { ...opts, reviews: undefined, review: opts.reviews && opts.reviews[file] }, dest, opts.pdfMode === 'sustituir' ? session.toJSON() : null);
    for (const it of newItems) session._register(it.type, it.value, it.placeholder);
    return { file, dest, ...r, hidden, redacted: true, substituted: opts.pdfMode === 'sustituir' };
  }
  if (ext === '.xlsx' || ext === '.docx') {
    const dest = outPath(file, outDir, suffix);
    const tools = {
      extra: opts.nerDir ? (text, ms) => nerMatches(text, opts.nerDir, ms) : null,
      redactImage: embeddedImage(opts)
    };
    const r = await (ext === '.docx' ? anonymizeDocx : anonymizeXlsx)(file, session, opts, dest, tools);
    return { file, dest, ...r };
  }

  const hidden = ext === '.pdf' ? await scanPdfHidden(file).catch(() => []) : [];

  const text = await readText(file);
  const skip = new Set(opts.skip || []);
  const ms = detect(text, opts).filter((m) => !skip.has(m.type + '|' + m.value));
  if (opts.nerDir) ms.push(...(await nerMatches(text, opts.nerDir, ms)).filter((m) => !skip.has(m.type + '|' + m.value)));
  ms.sort((a, b) => a.start - b.start);
  const anon = apply(text, ms, session);
  let dest;
  if (ext === '.pdf') {
    dest = outPath(file, outDir, suffix, '.docx');
    await writeDocx(anon, dest);
  } else {
    dest = outPath(file, outDir, suffix);
    fs.writeFileSync(dest, anon, 'utf8');
  }
  return { file, dest, counts: summarize(ms), total: ms.length, hidden };
}

/** Restaura los datos reales en un archivo devuelto por la IA (txt/md/csv/json/docx/xlsx). Escribe «.restaurado». */
async function restoreFile(file, session, outDir) {
  const ext = path.extname(file).toLowerCase();
  const dest = outPath(file, outDir, '.restaurado', ext === '.docx' ? '.docx' : ext);
  let restored = 0;
  const unknown = new Set();
  const fix = (t) => {
    const r = restore(t, session);
    restored += r.restored;
    r.unknown.forEach((u) => unknown.add(u));
    return r.text;
  };
  if (ext === '.xlsx' || ext === '.docx') {
    await restoreOoxml(file, dest, fix);
  } else if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
    fs.writeFileSync(dest, fix(fs.readFileSync(file, 'utf8')), 'utf8');
  } else {
    throw new Error('Solo se puede restaurar txt, md, csv, json, docx y xlsx');
  }
  return { file, dest, restored, unknown: [...unknown] };
}

function listFolder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFolder(p));
    else if (isSupported(p) && !/\.anonimo\./i.test(e.name)) out.push(p);
  }
  return out;
}

module.exports = { listDetections, scanPdfHidden, readText, processFile, restoreFile, listFolder, isSupported, SUPPORTED };
