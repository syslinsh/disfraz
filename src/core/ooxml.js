'use strict';
// Anonimiza .docx y .xlsx editando su XML en el sitio (conserva el formato) y limpia lo que suele quedar oculto:
// metadatos, miniatura, comentarios, textos alternativos, cachés, datos incrustados e imágenes con texto.
const path = require('path');
const JSZip = require('jszip');
const { detect, apply, summarize } = require('./anonymizer');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const skipKey = (m) => m.type + '|' + m.value;

/** Detección de un texto (sin las coincidencias que el usuario descartó en la revisión). */
function makeDetector(opts, extra) {
  const skip = new Set((opts && opts.skip) || []);
  const sync = (text) => detect(text, opts).filter((m) => !skip.has(skipKey(m)));
  const full = async (text) => {
    let ms = sync(text);
    if (extra) ms = ms.concat((await extra(text, ms)).filter((m) => !skip.has(skipKey(m)))).sort((a, b) => a.start - b.start);
    return ms;
  };
  return { sync, full };
}

/**
 * Busca nodos de texto con rx (grupos: 1 = etiqueta de apertura, 2 = contenido, 3 = cierre; el resto de coincidencias son separadores),
 * detecta sobre el texto completo y reescribe los nodos (el reemplazo va en el primer nodo tocado; en los demás se quita lo tapado).
 */
async function redactNodes(xml, rx, det, session, found) {
  return editNodes(xml, rx, async (text) => {
    const ms = await det.full(text);
    found.push(...ms);
    return ms.map((x) => ({ start: x.start, end: x.end, repl: session.placeholderFor(x.type, x.value) }));
  });
}

/** Como redactNodes, pero con una función que devuelve las ediciones [{start,end,repl}] del texto completo. */
async function editNodes(xml, rx, getEdits) {
  const nodes = [];
  let text = '';
  let m;
  rx.lastIndex = 0;
  while ((m = rx.exec(xml))) {
    if (m[2] !== undefined) {
      const t = unesc(m[2]);
      nodes.push({ at: m.index, len: m[0].length, open: m[1], close: m[3], from: text.length, to: text.length + t.length, text: t, edits: [] });
      text += t;
    } else text += /tab/.test(m[0]) ? '\t' : '\n';
  }
  if (!nodes.length) return xml;
  const ms = await getEdits(text);
  if (!ms.length) return xml;
  for (const x of ms) {
    const repl = x.repl;
    let first = true;
    for (const n of nodes) {
      if (n.to <= x.start || n.from >= x.end || n.to === n.from) continue;
      n.edits.push({ a: Math.max(x.start, n.from) - n.from, b: Math.min(x.end, n.to) - n.from, repl: first ? repl : '' });
      first = false;
    }
  }
  let out = '';
  let pos = 0;
  for (const n of nodes) {
    out += xml.slice(pos, n.at);
    pos = n.at + n.len;
    if (!n.edits.length) {
      out += xml.slice(n.at, pos);
      continue;
    }
    let t = '';
    let p = 0;
    for (const e of n.edits) {
      t += n.text.slice(p, e.a) + e.repl;
      p = e.b;
    }
    t += n.text.slice(p);
    const open = /xml:space/.test(n.open) || !/^<(w:t|w:delText|w:instrText)\b/.test(n.open) ? n.open : n.open.replace(/>$/, ' xml:space="preserve">');
    out += open + esc(t) + n.close;
  }
  return out + xml.slice(pos);
}

/** Atributos con texto visible (alt-text, descripciones emergentes, texto de enlaces): se anonimizan. Autores: se vacían. */
function redactAttrs(xml, names, det, session, found) {
  const rx = new RegExp('(\\s(?:' + names + ')=")([^"]*)(")', 'g');
  return xml.replace(rx, (all, a, v, z) => {
    const t = unesc(v);
    const ms = det.sync(t);
    if (!ms.length) return all;
    found.push(...ms);
    return a + esc(apply(t, ms, session)) + z;
  });
}

const blankAuthors = (xml) => xml.replace(/(\s(?:w:author|w:initials|w15:author|w:userName)=")[^"]*(")/g, '$1$2');

/** Quita nombre, empresa, título… de docProps. */
function cleanProps(xml) {
  return xml
    .replace(/(<(?:dc:creator|cp:lastModifiedBy|dc:title|dc:subject|dc:description|cp:keywords|Company|Manager|cp:category|HyperlinkBase)>)[^<]*(<\/)/g, '$1$2')
    .replace(/<(?:TitlesOfParts|HeadingPairs)>[\s\S]*?<\/(?:TitlesOfParts|HeadingPairs)>/g, '');
}

/** Borra partes del paquete y las referencias a ellas (relaciones y tipos de contenido). */
function dropParts(zip, test) {
  const dropped = new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir && test(n)));
  if (!dropped.size) return [];
  for (const n of dropped) zip.remove(n);
  return [...dropped];
}

async function cleanRels(zip, dropped, det, session, found) {
  const set = new Set(dropped);
  for (const n of Object.keys(zip.files)) {
    if (!/\.rels$/.test(n)) continue;
    const base = path.posix.dirname(path.posix.dirname(n));
    let x = await zip.file(n).async('string');
    x = x.replace(/<Relationship\b[^>]*\/>/g, (rel) => {
      const target = (rel.match(/\sTarget="([^"]*)"/) || [])[1] || '';
      if (/TargetMode="External"/.test(rel)) {
        const ms = det.sync(unesc(target));
        if (!ms.length) return rel;
        found.push(...ms);
        return rel.replace(/(\sTarget=")[^"]*(")/, '$1about:blank$2');
      }
      const full = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(base === '.' ? '' : base, target));
      return set.has(full) ? '' : rel;
    });
    zip.file(n, x);
  }
  if (zip.file('[Content_Types].xml')) {
    let ct = await zip.file('[Content_Types].xml').async('string');
    ct = ct.replace(/<Override\b[^>]*PartName="\/([^"]*)"[^>]*\/>/g, (o, p) => (set.has(p) ? '' : o));
    zip.file('[Content_Types].xml', ct);
  }
}

const IMG = /\.(png|jpe?g)$/i;

async function redactMedia(zip, prefix, tools, found, warn) {
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir || !n.startsWith(prefix)) continue;
    if (IMG.test(n)) {
      const buf = await zip.file(n).async('nodebuffer');
      if (buf.length < 3000 || !tools || !tools.redactImage) continue;
      try {
        const r = await tools.redactImage(buf, path.extname(n));
        if (r.total) {
          zip.file(n, r.buf);
          found.img = found.img || {};
          for (const [k, v] of Object.entries(r.counts || {})) found.img[k] = (found.img[k] || 0) + v;
          found.imgTotal = (found.imgTotal || 0) + r.total;
        }
      } catch {
        warn.push('Imagen no revisada: ' + n);
      }
    } else if (/\.(emf|wmf|gif|tiff?|bmp|svg)$/i.test(n)) warn.push('Imagen no revisada (formato): ' + n);
  }
}

/** Después de limpiar: ¿queda algún valor detectado en alguna parte del paquete? */
async function residues(zip, found) {
  const values = [...new Set(found.map((m) => m.value))].filter((v) => v.length >= 4);
  const hits = [];
  if (!values.length) return hits;
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir || !/\.(xml|rels|vml)$/i.test(n) || n === '[Content_Types].xml') continue;
    const x = unesc(await zip.file(n).async('string'));
    if (values.some((v) => x.includes(v))) hits.push(n);
  }
  return hits;
}

const DOCX_TEXT = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments\w*)\.xml$|^word\/(charts|diagrams)\/[^/]+\.xml$/;
const DOCX_NODES = /(<(?:w:t|w:delText|w:instrText|a:t)(?:\s[^>]*)?>)([^<]*)(<\/(?:w:t|w:delText|w:instrText|a:t)>)|<\/w:p>|<\/a:p>|<w:tab\/>|<w:br\/>/g;

async function anonymizeDocx(file, session, opts, dest, tools) {
  const fs = require('fs');
  const det = makeDetector(opts, tools && tools.extra);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const found = [];
  const warn = [];
  const dropped = dropParts(
    zip,
    (n) => /^docProps\/thumbnail\./i.test(n) || /^customXml\//.test(n) || /^word\/glossary\//.test(n) || /^word\/printerSettings\//.test(n) || n === 'word/people.xml' || /^word\/commentsExtensible\.xml$|^word\/commentsIds\.xml$/.test(n)
  );
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir || !/\.xml$/.test(n)) continue;
    let x = await zip.file(n).async('string');
    const before = x;
    if (DOCX_TEXT.test(n)) {
      x = await redactNodes(x, new RegExp(DOCX_NODES.source, 'g'), det, session, found);
      x = redactAttrs(x, 'descr|title|tooltip|w:tooltip|alt', det, session, found);
    }
    if (/^word\/[^/]+\.xml$/.test(n)) x = blankAuthors(x);
    if (n === 'word/settings.xml') x = x.replace(/<w:docVars>[\s\S]*?<\/w:docVars>|<w:mailMerge>[\s\S]*?<\/w:mailMerge>/g, '');
    if (n === 'docProps/core.xml' || n === 'docProps/app.xml') x = cleanProps(x);
    if (x !== before) zip.file(n, x);
  }
  await redactMedia(zip, 'word/media/', tools, found, warn);
  await cleanRels(zip, dropped, det, session, found);
  for (const n of Object.keys(zip.files)) if (/^word\/embeddings\//.test(n) && !zip.files[n].dir) warn.push('Objeto incrustado no revisado: ' + n);
  return finish(zip, found, warn, dest);
}

async function finish(zip, found, warn, dest) {
  const left = await residues(zip, found);
  require('fs').writeFileSync(dest, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const counts = { ...summarize(found) };
  for (const [k, v] of Object.entries(found.img || {})) counts[k] = (counts[k] || 0) + v;
  return { counts, total: found.length + (found.imgTotal || 0), warn, residues: left };
}

/** Restaura los marcadores en .docx/.xlsx editando el XML (conserva el formato). */
async function restoreOoxml(file, dest, fix) {
  const fs = require('fs');
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const getEdits = async (text) => {
    const edits = [];
    let off = 0;
    for (const line of text.split('\n')) {
      const r = fix(line);
      if (r !== line) {
        let a = 0;
        while (a < line.length && a < r.length && line[a] === r[a]) a++;
        let b = 0;
        while (b < line.length - a && b < r.length - a && line[line.length - 1 - b] === r[r.length - 1 - b]) b++;
        edits.push({ start: off + a, end: off + line.length - b, repl: r.slice(a, r.length - b) });
      }
      off += line.length + 1;
    }
    return edits;
  };
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir || !/\.xml$/.test(n)) continue;
    const isDoc = DOCX_TEXT.test(n);
    const isXl = /^xl\/(sharedStrings|comments\d*)\.xml$|^xl\/worksheets\/[^/]+\.xml$/.test(n);
    if (!isDoc && !isXl) continue;
    const x = await zip.file(n).async('string');
    let y = x;
    if (isDoc) y = await editNodes(y, new RegExp(DOCX_NODES.source, 'g'), getEdits);
    else {
      y = await editNodes(y, /(<t(?:\s[^>]*)?>)([^<]*)(<\/t>)|<\/si>|<\/is>|<\/text>/g, getEdits);
      y = y.replace(/(<c\b[^>]*\bt="str"[^>]*>[\s\S]*?<v>)([^<]*)(<\/v>)/g, (all, a, v, z) => a + esc(fix(unesc(v))) + z);
    }
    if (y !== x) zip.file(n, y);
  }
  fs.writeFileSync(dest, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

const XLSX_NODES = /(<t(?:\s[^>]*)?>)([^<]*)(<\/t>)|(<a:t>)([^<]*)(<\/a:t>)|<\/si>|<\/is>|<\/text>/g;
const SHEET_HF = /(<(?:oddHeader|oddFooter|evenHeader|evenFooter|firstHeader|firstFooter)>)([^<]*)(<\/)/g;

async function anonymizeXlsx(file, session, opts, dest, tools) {
  const fs = require('fs');
  const det = makeDetector(opts, tools && tools.extra);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const found = [];
  const warn = [];
  const dropped = dropParts(
    zip,
    (n) =>
      /^docProps\/thumbnail\./i.test(n) ||
      /^customXml\//.test(n) ||
      /^xl\/(pivotCache|pivotTables|externalLinks|richData|queryTables|persons|threadedComments|printerSettings)\//.test(n) ||
      n === 'xl/metadata.xml' ||
      n === 'xl/connections.xml'
  );
  const anonText = (t) => {
    const ms = det.sync(t);
    if (!ms.length) return t;
    found.push(...ms);
    return apply(t, ms, session);
  };
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir || !/\.xml$/.test(n)) continue;
    let x = await zip.file(n).async('string');
    const before = x;
    if (/^xl\/(sharedStrings|comments\d*)\.xml$|^xl\/(drawings|charts)\/[^/]+\.xml$/.test(n) || /^xl\/worksheets\/[^/]+\.xml$/.test(n)) {
      x = x.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      // los nodos <t> y <a:t> usan grupos distintos: se procesan en dos pasadas con la misma lógica
      x = await redactNodes(x, /(<t(?:\s[^>]*)?>)([^<]*)(<\/t>)|<\/si>|<\/is>|<\/text>/g, det, session, found);
      x = await redactNodes(x, /(<a:t>)([^<]*)(<\/a:t>)|<\/a:p>/g, det, session, found);
    }
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(n)) {
      x = x.replace(SHEET_HF, (all, a, v, z) => a + esc(anonText(unesc(v))) + z);
      x = x.replace(/(<c\b[^>]*\bt="str"[^>]*>[\s\S]*?<v>)([^<]*)(<\/v>)/g, (all, a, v, z) => a + esc(anonText(unesc(v))) + z);
      x = redactAttrs(x, 'display|tooltip|location', det, session, found);
      x = x.replace(/(<c\b[^>]*?)\s(?:vm|cm)="\d+"/g, '$1');
    }
    if (/^xl\/comments\d*\.xml$/.test(n)) x = x.replace(/<author>[^<]*<\/author>/g, '<author></author>');
    if (n === 'xl/workbook.xml') x = x.replace(/<pivotCaches>[\s\S]*?<\/pivotCaches>|<externalReferences>[\s\S]*?<\/externalReferences>/g, '');
    if (n === 'docProps/core.xml' || n === 'docProps/app.xml') x = cleanProps(x);
    if (x !== before) zip.file(n, x);
  }
  await redactMedia(zip, 'xl/media/', tools, found, warn);
  await cleanRels(zip, dropped, det, session, found);
  return finish(zip, found, warn, dest);
}

module.exports = { anonymizeDocx, anonymizeXlsx, restoreOoxml, skipKey };
