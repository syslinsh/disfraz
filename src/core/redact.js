'use strict';
// Tachado real: renderiza cada página, tapa los datos con cajas negras y reconstruye el PDF solo con imágenes
// (el texto original, los metadatos y el texto oculto desaparecen). Páginas sin capa de texto → OCR local.
const fs = require('fs');
const path = require('path');
const { detect, summarize, apply, Session } = require('./anonymizer');
const { inElectronMain, runInChild } = require('./child');
const { nerMatches } = require('./ner');

const SCALE = 2.5;
const PAD = 2;
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

let ocrWorker = null;
async function getOcr() {
  if (ocrWorker) return ocrWorker;
  const { createWorker } = require('tesseract.js');
  const langPath = unpacked(path.dirname(require.resolve('@tesseract.js-data/spa/package.json'))) + path.sep + '4.0.0_best_int';
  const workerPath = unpacked(require.resolve('tesseract.js/src/worker-script/node/index.js'));
  const corePath = unpacked(path.dirname(require.resolve('tesseract.js-core/package.json')));
  ocrWorker = await createWorker('spa', 1, { langPath, workerPath, corePath, gzip: true, cacheMethod: 'none' });
  return ocrWorker;
}
async function closeOcr() {
  if (ocrWorker) await ocrWorker.terminate();
  ocrWorker = null;
}

/** OCR → segmentos {text,x0,y0,x1,y1} en píxeles de la imagen. */
async function ocrSegments(buffer) {
  const w = await getOcr();
  const { data } = await w.recognize(buffer, {}, { blocks: true });
  const words = [];
  for (const b of data.blocks || [])
    for (const p of b.paragraphs || [])
      for (const l of p.lines || [])
        for (const wd of l.words || []) if (wd.text && wd.text.trim()) words.push({ text: wd.text, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1 });
  return words;
}

/** OCR normal + OCR con los colores invertidos (para letras claras sobre fondo oscuro); se añaden las palabras nuevas. */
async function ocrDual(canvas, make) {
  const a = await ocrSegments(canvas.toBuffer('image/png'));
  const inv = make(canvas.width, canvas.height);
  inv.context.drawImage(canvas, 0, 0);
  // se invierte solo donde el fondo es oscuro (fondo medio de la zona < 115), así todo queda como letra oscura sobre fondo claro
  const W = canvas.width;
  const H = canvas.height;
  const px = inv.context.getImageData(0, 0, W, H);
  const d = px.data;
  const R = 60;
  const sat = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      row += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1] + row;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(H, y + R + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(W, x + R + 1);
      const mean = (sat[y1 * (W + 1) + x1] - sat[y0 * (W + 1) + x1] - sat[y1 * (W + 1) + x0] + sat[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      if (mean < 115) {
        const i = (y * W + x) * 4;
        d[i] = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
    }
  }
  inv.context.putImageData(px, 0, 0);
  const b = await ocrSegments(inv.canvas.toBuffer('image/png'));
  const overlaps = (x, y) => {
    const ox = Math.min(x.x1, y.x1) - Math.max(x.x0, y.x0);
    const oy = Math.min(x.y1, y.y1) - Math.max(x.y0, y.y0);
    return ox > 0 && oy > 0 && ox * oy > 0.3 * Math.min((x.x1 - x.x0) * (x.y1 - x.y0), (y.x1 - y.x0) * (y.y1 - y.y0));
  };
  // tercera pasada a media escala: los títulos muy grandes se leen mejor más pequeños
  const half = make(Math.round(W / 2), Math.round(H / 2));
  half.context.drawImage(canvas, 0, 0, half.canvas.width, half.canvas.height);
  const c = (await ocrSegments(half.canvas.toBuffer('image/png'))).map((w) => ({ text: w.text, x0: w.x0 * 2, y0: w.y0 * 2, x1: w.x1 * 2, y1: w.y1 * 2 }));
  const clean = (w) => w.text.replace(/[^\p{L}\d]/gu, '').length >= 2;
  const out = [...a];
  for (const w of [...b, ...c]) if (clean(w) && !out.some((o) => overlaps(o, w))) out.push(w);
  return out;
}

/** Une segmentos en un texto, recordando la posición de cada uno. Devuelve {text, segs:[{...seg, from, to}]}. */
function layout(segs) {
  let text = '';
  let prev = null;
  const out = [];
  for (const s of segs) {
    if (prev) {
      const h = Math.max(prev.y1 - prev.y0, s.y1 - s.y0, 1);
      const sameLine = Math.abs((s.y0 + s.y1) / 2 - (prev.y0 + prev.y1) / 2) < h * 0.6 && s.x0 >= prev.x0 - 2;
      text += sameLine ? ' ' : '\n';
    }
    const from = text.length;
    text += s.text;
    out.push({ ...s, from, to: text.length });
    prev = s;
  }
  return { text, segs: out };
}

/** El OCR confunde Z→7, @→Q…: reglas más tolerantes que solo se aplican a texto leído por OCR. */
const LENIENT = [
  ['DNI', /(?<=\b(?:DNI|NIF|NIE)[:\s.-]{0,3})[XYZ0-9]\d{7}[A-Z0-9]\b/g],
  ['EMAIL', /\b[\w.+-]{2,}[^\s\w.@-]{0,2}[\w-]*\.(?:com|es|org|net|eu|cat)\b/gi],
  ['IBAN', /\bES\s?\d{2}(?:\s?\d{4}){5}\b/g]
];
function withLenient(text, ms, opts) {
  const enabled = opts && opts.enabled ? opts.enabled : {};
  const out = [...ms];
  for (const [type, re] of LENIENT) {
    if (type in enabled && !enabled[type]) continue;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!out.some((o) => start < o.end && end > o.start)) out.push({ type, value: m[0], start, end });
    }
  }
  return out;
}

/** Cajas (en píxeles) que cubren cada coincidencia, repartiendo por caracteres dentro del segmento. */
function boxesFor(matches, segs) {
  const boxes = [];
  for (const m of matches) {
    for (const s of segs) {
      if (m.end <= s.from || m.start >= s.to) continue;
      const len = Math.max(s.to - s.from, 1);
      const a = Math.max(m.start, s.from) - s.from;
      const b = Math.min(m.end, s.to) - s.from;
      const w = s.x1 - s.x0;
      const px = Math.max(PAD, (w / len) * 0.7); // la fuente es proporcional: margen de medio carácter para no dejar letras sueltas
      boxes.push({ x: s.x0 + (a / len) * w - px, y: s.y0 - PAD, w: ((b - a) / len) * w + px * 2, h: s.y1 - s.y0 + PAD * 2 });
    }
  }
  return boxes;
}

function blackout(ctx, boxes) {
  ctx.fillStyle = '#000';
  for (const b of boxes) ctx.fillRect(b.x, b.y, b.w, b.h);
}

/** Sustituye en vez de tachar: caja blanca con el marcador (o dato falso) dibujado encima, ajustado al hueco. */
function substitute(ctx, matches, segs, session) {
  for (const m of matches) {
    const ph = session.placeholderFor(m.type, m.value);
    const lines = [];
    for (const b of boxesFor([m], segs)) {
      const l = lines.find((x) => Math.abs(x.y - b.y) < b.h * 0.5);
      if (l) {
        const r = Math.max(l.x + l.w, b.x + b.w);
        l.x = Math.min(l.x, b.x);
        l.w = r - l.x;
      } else lines.push({ ...b });
    }
    lines.forEach((l, i) => {
      // color de fondo: se toma justo a la izquierda de la caja (así no queda un rectángulo blanco sobre fondos de color)
      let bg = [255, 255, 255];
      try {
        const sx = Math.max(0, Math.floor(l.x - 3));
        const sy = Math.max(0, Math.floor(l.y + l.h / 2));
        const p = ctx.getImageData(sx, sy, 1, 1).data;
        bg = [p[0], p[1], p[2]];
      } catch {
        /* fondo blanco por defecto */
      }
      const dark = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2] < 140;
      // tamaño de letra uniforme (según la altura de la línea); solo se reduce si no cabe y, como mínimo, la mitad
      let size = l.h * 0.62;
      ctx.font = `${size}px Arial`;
      while (ctx.measureText(ph).width > l.w - 4 && size > l.h * 0.45) {
        size -= 0.5;
        ctx.font = `${size}px Arial`;
      }
      if (i === 0) l.w = Math.max(l.w, ctx.measureText(ph).width + 8);
      ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      ctx.fillRect(l.x, l.y, l.w, l.h);
      if (i === 0) {
        ctx.fillStyle = dark ? '#ffffff' : '#12337a';
        ctx.textBaseline = 'middle';
        ctx.fillText(ph, l.x + 4, l.y + l.h / 2);
      }
    });
  }
}

/** Capa de texto invisible con el texto ya anonimizado (para que una IA pueda leer el PDF). */
function addTextLayer(pg, font, text) {
  const safe = (str) =>
    [...str]
      .map((c) => {
        if (c.charCodeAt(0) < 32) return ' ';
        try {
          font.encodeText(c);
          return c;
        } catch {
          return '?';
        }
      })
      .join('');
  const lines = text.split(String.fromCharCode(10));
  const lh = Math.min(8, (pg.getHeight() - 8) / Math.max(lines.length, 1));
  lines.forEach((ln, i) => {
    if (ln.trim()) pg.drawText(safe(ln), { x: 4, y: pg.getHeight() - 6 - i * lh, size: Math.max(lh * 0.8, 1), font, opacity: 0 });
  });
}

/** Segmentos de la capa de texto de una página, en píxeles del viewport. */
async function textLayerSegments(page, viewport, pdfjs) {
  const content = await page.getTextContent();
  const segs = [];
  for (const it of content.items) {
    if (!('str' in it) || !it.str.trim()) continue;
    const [a, b, , d, e, f] = pdfjs.Util.transform(viewport.transform, it.transform);
    const size = Math.hypot(a, b) || Math.abs(d);
    if (size < 2 * SCALE) continue; // texto diminuto/oculto: no se dibuja, no hace falta tapar
    const width = it.width * viewport.scale;
    segs.push({ text: it.str, x0: e, y0: f - size * 0.85, x1: e + width, y1: f + size * 0.25 });
  }
  return segs;
}

/** Fuentes estándar y cmaps de pdfjs: sin ellos las fuentes no incrustadas (Helvetica…) se dibujan en blanco. */
function pdfjsAssets() {
  const root = unpacked(path.dirname(require.resolve('pdfjs-dist/package.json')));
  return { standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep, cMapUrl: path.join(root, 'cmaps') + path.sep, cMapPacked: true };
}

/** Renderiza una página y detecta datos. Devuelve lo necesario para tachar o para mostrar la revisión. */
async function hasImages(page, pdfjs) {
  const { OPS } = pdfjs;
  const ops = await page.getOperatorList();
  return ops.fnArray.some((f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject || f === OPS.paintImageMaskXObject);
}

async function analyzePage(doc, pdfjs, p, opts) {
  const page = await doc.getPage(p);
  const viewport = page.getViewport({ scale: SCALE });
  // el canvas lo crea pdfjs (su propia fábrica): con un canvas externo el renderizado se cae con PDF reales
  const { canvas, context: ctx } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  let segs = await textLayerSegments(page, viewport, pdfjs);
  let ocr = false;
  if (segs.reduce((n, s) => n + s.text.length, 0) < 15) {
    segs = await ocrDual(canvas, (w, h) => doc.canvasFactory.create(w, h));
    ocr = true;
  } else if (await hasImages(page, pdfjs)) {
    // PDF con texto y además imágenes (capturas, DNI pegados): se lee también lo que dicen las imágenes
    const extra = await ocrDual(canvas, (w, h) => doc.canvasFactory.create(w, h));
    const over = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > (a.y1 - a.y0) * 0.3;
    const add = extra.filter((e) => !segs.some((s) => over(e, s)));
    if (add.length) {
      segs = segs.concat(add);
      ocr = true;
    }
  }
  const lay = layout(segs);
  let ms = detect(lay.text, opts);
  if (ocr) ms = withLenient(lay.text, ms, opts);
  if (opts && opts.nerDir) ms = ms.concat(await nerMatches(lay.text, opts.nerDir, ms));
  ms.sort((a, b) => a.start - b.start).forEach((m, i) => (m.id = i)); // ids estables: la revisión se aplica sobre ellos
  return { canvas, ctx, viewport, lay, ms, ocr };
}

/**
 * Aplica la revisión manual de una página: quita las detecciones descartadas y convierte las cajas dibujadas a mano
 * en coincidencias sobre el texto que tapan (así también se anonimiza la capa de texto). Lo que no toque texto se tacha en negro.
 * review = { excluded: [ids], manual: [{x,y,w,h}] } en píxeles de la página (escala SCALE).
 */
function applyReview(ms, lay, review, terms = []) {
  if (!review && !terms.length) return { ms, blacks: [], terms: [] };
  review = review || {};
  const out = ms.filter((m) => !(review.excluded || []).includes(m.id));
  const blacks = [];
  const found = [];
  for (const b of review.manual || []) {
    let hit = false;
    for (const s of lay.segs) {
      const oy = Math.min(b.y + b.h, s.y1) - Math.max(b.y, s.y0);
      const ox = Math.min(b.x + b.w, s.x1) - Math.max(b.x, s.x0);
      if (oy < (s.y1 - s.y0) * 0.3 || ox <= 0) continue;
      const len = Math.max(s.to - s.from, 1);
      const w = Math.max(s.x1 - s.x0, 1);
      const a = s.from + Math.floor(Math.max(0, (b.x - s.x0) / w) * len);
      const z = s.from + Math.ceil(Math.min(1, (b.x + b.w - s.x0) / w) * len);
      if (z <= a || out.some((m) => a < m.end && z > m.start)) continue;
      out.push({ type: 'MANUAL', value: lay.text.slice(a, z), start: a, end: z });
      if (b.all) found.push(lay.text.slice(a, z).trim());
      hit = true;
    }
    blacks.push({ ...b, always: !hit });
  }
  // «todas las apariciones»: lo marcado a mano (en esta u otra página) se tapa en todo el documento
  for (const t of [...new Set([...terms, ...found])]) {
    if (t.replace(/\s/g, '').length < 3) continue;
    const re = new RegExp('(?<![\\p{L}\\d])' + t.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+') + '(?![\\p{L}\\d])', 'giu');
    for (const m of lay.text.matchAll(re)) {
      const a = m.index;
      const z = a + m[0].length;
      if (out.some((o) => a < o.end && z > o.start)) continue;
      out.push({ type: 'MANUAL', value: m[0], start: a, end: z });
    }
  }
  out.sort((x, y) => x.start - y.start);
  return { ms: out, blacks, terms: found };
}

async function openPdf(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, verbosity: 0, ...pdfjsAssets() }).promise;
  return { pdfjs, doc };
}

/** Para la pantalla de revisión: imagen de cada página + cajas detectadas (en píxeles a escala SCALE). */
async function analyzePdfInline(file, opts) {
  const { pdfjs, doc } = await openPdf(file);
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const a = await analyzePage(doc, pdfjs, p, opts);
    pages.push({
      w: a.canvas.width,
      h: a.canvas.height,
      img: 'data:image/jpeg;base64,' + a.canvas.toBuffer('image/jpeg', 70).toString('base64'),
      boxes: a.ms.map((m) => ({ id: m.id, type: m.type, value: m.value, rects: boxesFor([m], a.lay.segs) }))
    });
  }
  return { pages };
}

async function redactPdfInline(file, opts, dest, onProgress, sessionData) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const sub = opts && opts.pdfMode === 'sustituir';
  const session = sub ? new Session(sessionData || {}) : null;
  const before = session ? session.items.length : 0;
  const { pdfjs, doc } = await openPdf(file);
  const out = await PDFDocument.create();
  out.setCreator('Disfraz');
  out.setProducer('Disfraz');
  const font = sub ? await out.embedFont(StandardFonts.Helvetica) : null;
  const all = [];
  let ocrPages = 0;
  // pasada previa: textos marcados a mano con «todas las apariciones» (se buscan luego en todas las páginas)
  const repeat = [];
  const rvAll = (opts && opts.review) || {};
  for (const p of Object.keys(rvAll)) {
    if (!(rvAll[p].manual || []).some((b) => b.all)) continue;
    const a = await analyzePage(doc, pdfjs, +p, opts);
    repeat.push(...applyReview(a.ms, a.lay, rvAll[p]).terms);
  }
  for (let p = 1; p <= doc.numPages; p++) {
    if (onProgress) onProgress(p, doc.numPages);
    const a = await analyzePage(doc, pdfjs, p, opts);
    const { canvas, ctx, viewport, lay } = a;
    if (a.ocr) ocrPages++;
    const rv = applyReview(a.ms, lay, opts && opts.review && opts.review[p], repeat);
    const ms = rv.ms;
    if (sub) substitute(ctx, ms, lay.segs, session);
    else blackout(ctx, boxesFor(ms, lay.segs));
    blackout(ctx, rv.blacks.filter((b) => !sub || b.always));
    all.push(...ms);
    const img = await out.embedJpg(canvas.toBuffer('image/jpeg', 88));
    const pg = out.addPage([viewport.width / SCALE, viewport.height / SCALE]);
    pg.drawImage(img, { x: 0, y: 0, width: pg.getWidth(), height: pg.getHeight() });
    if (sub) addTextLayer(pg, font, apply(lay.text, ms, session));
  }
  fs.writeFileSync(dest, await out.save());
  return { counts: summarize(all), total: all.length, ocrPages, pages: doc.numPages, newItems: session ? session.items.slice(before) : [] };
}

async function redactImageInline(file, opts, dest) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const img = await loadImage(fs.readFileSync(file));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  // reescala hacia arriba las fotos pequeñas para que el OCR lea mejor
  const k = img.width < 1400 ? 2 : 1;
  let src = canvas;
  if (k > 1) {
    src = createCanvas(img.width * k, img.height * k);
    src.getContext('2d').drawImage(img, 0, 0, img.width * k, img.height * k);
  }
  const segs = (await ocrSegments(src.toBuffer('image/png'))).map((s) => ({ ...s, x0: s.x0 / k, y0: s.y0 / k, x1: s.x1 / k, y1: s.y1 / k }));
  const lay = layout(segs);
  const ms = withLenient(lay.text, detect(lay.text, opts), opts);
  blackout(ctx, boxesFor(ms, lay.segs));
  fs.writeFileSync(dest, canvas.toBuffer('image/png')); // PNG nuevo: sin EXIF/GPS del original
  return { counts: summarize(ms), total: ms.length };
}

const redactPdf = (file, opts, dest, sessionData) =>
  inElectronMain() ? runInChild('pdf', [file, opts, dest, sessionData]) : redactPdfInline(file, opts, dest, null, sessionData);
const analyzePdf = (file, opts) => (inElectronMain() ? runInChild('analyze', [file, opts]) : analyzePdfInline(file, opts));
const redactImage = (file, opts, dest) => (inElectronMain() ? runInChild('image', [file, opts, dest]) : redactImageInline(file, opts, dest));

module.exports = { ocrSegments, analyzePdf, analyzePdfInline, applyReview, redactPdf, redactImage, redactPdfInline, redactImageInline, closeOcr, layout, boxesFor };
