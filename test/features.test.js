'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session, detect, apply } = require('../src/core/anonymizer');
const { processFile, restoreFile, readText } = require('../src/core/files');
const { closeOcr } = require('../src/core/redact');
const { AuditLog } = require('../src/core/audit');
const { profileConfig } = require('../src/core/profiles');
const { TYPES } = require('../src/core/detectors');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anoni-f-'));

function miniPdf(text) {
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

test('pdf tachado: sin texto debajo de las cajas y con huella', async () => {
  const f = path.join(dir, 'p.pdf');
  fs.writeFileSync(f, miniPdf('Cliente DNI 12345678Z contacto ernesto@example.com'));
  const r = await processFile(f, new Session(), {}, null);
  assert.ok(r.redacted && r.total >= 2 && r.sha256.length === 64);
  assert.ok(r.dest.endsWith('.anonimo.pdf'));
  const txt = await readText(r.dest);
  assert.ok(!txt.includes('12345678Z') && !txt.includes('example.com'), txt);
});

test('imagen con texto: OCR local y tachado', async () => {
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(900, 200);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 900, 200);
  x.fillStyle = '#000';
  x.font = '36px Arial';
  x.fillText('DNI 12345678Z  Tel 612 345 678', 30, 80);
  x.fillText('Correo ernesto@example.com', 30, 160);
  const f = path.join(dir, 'foto.png');
  fs.writeFileSync(f, c.toBuffer('image/png'));
  const r = await processFile(f, new Session(), {}, null);
  await closeOcr();
  assert.ok(r.total >= 3, JSON.stringify(r.counts));
  assert.ok(fs.existsSync(r.dest) && r.dest.endsWith('.anonimo.png'));
});

test('restaurar archivos completos (txt y xlsx)', async () => {
  const s = new Session();
  const T = 'Contacto: ernesto@example.com';
  const anon = apply(T, detect(T), s);
  const f = path.join(dir, 'ia.txt');
  fs.writeFileSync(f, 'Respuesta: escribe a ' + anon);
  const r = await restoreFile(f, s, null);
  assert.ok(fs.readFileSync(r.dest, 'utf8').includes('ernesto@example.com') && r.restored === 1);

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('H').addRow([anon, 7]);
  const fx = path.join(dir, 'ia.xlsx');
  await wb.xlsx.writeFile(fx);
  const rx = await restoreFile(fx, s, null);
  assert.ok((await readText(rx.dest)).includes('ernesto@example.com'));
});

test('perfiles activan y apagan tipos', () => {
  const cfg = profileConfig('financiero', TYPES);
  assert.strictEqual(cfg.enabled.IMPORTE, true);
  assert.strictEqual(profileConfig('general', TYPES).enabled.IMPORTE, false);
});

test('nuevos detectores: NSS y referencias', () => {
  const d = detect('Afiliación 28/12345678/40, Autos n.º 123/2024, NHC: 458812').map((m) => m.type);
  assert.ok(d.includes('NSS') && d.includes('REFERENCIA'));
});

test('escrito de cambio de titularidad: detecta todo y cambiar de modo sustituye de verdad', () => {
  const T = 'Yo, Elena Marcos Ibarra, con DNI/NIE 00000000T, solicito el cambio a favor de:\nNuevo titular:\nD./Dña. Noelia gil ramos \nDNI/NIE: 11111111\nDirección:  camino del olivo 12\nTeléfono de contacto: 6123456780\nCorreo electrónico: demo@example.com';
  const ms = detect(T, {});
  const tipos = ms.map((m) => m.type).join(',');
  assert.strictEqual(tipos, 'PERSONA,DNI,PERSONA,DNI,DIRECCION,TELEFONO,EMAIL');
  const s = new Session();
  apply(T, ms, s); // primero en modo marcadores
  s.mode = 'realista';
  const out = apply(T, ms, s);
  for (const real of ['Marcos', '00000000T', 'Noelia', '11111111', 'olivo', '6123456780', 'demo@']) assert.ok(!out.includes(real), real);
  assert.ok(!/\[[A-Z]+_\d+\]/.test(out), out);
});

test('informe de auditoría no contiene datos reales', () => {
  const log = new AuditLog();
  const T = 'DNI 12345678Z de D. Ernesto Valcárcel Ruiz';
  log.addText(T, detect(T), 'marcadores');
  const md = log.toMarkdown() + JSON.stringify(log.toJSON());
  assert.ok(!md.includes('12345678Z') && !md.includes('Valcárcel') && md.includes('DNI 1'));
});

test('pdf sustituir: marcadores en la imagen, capa de texto sin datos reales y sesión actualizada', async () => {
  const f = path.join(dir, 'sus.pdf');
  fs.writeFileSync(f, miniPdf('Cliente DNI 12345678Z contacto ernesto@example.com'));
  const s = new Session();
  const r = await processFile(f, s, { pdfMode: 'sustituir' }, null);
  assert.ok(r.redacted && r.substituted && r.total >= 2);
  const txt = await readText(r.dest);
  assert.ok(!txt.includes('12345678Z') && !txt.includes('example.com'), txt);
  assert.ok(/\[DNI_1\]/.test(txt) && /\[EMAIL_1\]/.test(txt), txt);
  assert.ok(s.items.some((i) => i.value === '12345678Z'));
});

test('revisión manual de pdf: descartar una detección y tapar a mano otra cosa', async () => {
  const { analyzePdfInline } = require('../src/core/redact');
  const f = path.join(dir, 'rev.pdf');
  fs.writeFileSync(f, miniPdf('Cliente DNI 12345678Z contacto ernesto@example.com'));
  const an = await analyzePdfInline(f, {});
  const mail = an.pages[0].boxes.find((b) => b.type === 'EMAIL');
  assert.ok(an.pages[0].img.startsWith('data:image/jpeg') && mail && an.pages[0].boxes.length >= 2);
  const reviews = { [f]: { 1: { excluded: [mail.id], manual: [{ x: 100, y: 200, w: 110, h: 60 }] } } };
  const r = await processFile(f, new Session(), { pdfMode: 'sustituir', reviews }, null);
  const txt = await readText(r.dest);
  assert.ok(txt.includes('example.com'), 'la detección descartada no se toca: ' + txt);
  assert.ok(!txt.includes('12345678Z') && !txt.includes('Cliente'), txt);
});

test('pdf con texto e imagen incrustada: también se lee y tapa el texto de la imagen', async () => {
  const { analyzePdfInline } = require('../src/core/redact');
  const { PDFDocument } = require('pdf-lib');
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(900, 160);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 900, 160);
  g.fillStyle = '#000';
  g.font = 'bold 64px sans-serif';
  g.fillText('DNI 87654321X', 30, 100);
  const pdf = await PDFDocument.create();
  const pg = pdf.addPage([595, 400]);
  pg.drawText('Documento adjunto con texto normal de varias palabras', { x: 40, y: 360, size: 12 });
  const img = await pdf.embedPng(c.toBuffer('image/png'));
  pg.drawImage(img, { x: 40, y: 150, width: 450, height: 80 });
  const f = path.join(dir, 'imgtxt.pdf');
  fs.writeFileSync(f, await pdf.save());
  const an = await analyzePdfInline(f, {});
  await closeOcr();
  assert.ok(an.pages[0].boxes.some((b) => b.type === 'DNI'), JSON.stringify(an.pages[0].boxes.map((b) => b.type + ':' + b.value)));
});

test('revisión: «todas las apariciones» tapa lo marcado a mano en todo el documento', async () => {
  const { applyReview } = require('../src/core/redact');
  const text = 'Proyecto Zafiro aprobado y fin del proyecto  zafiro';
  const lay = { text, segs: [{ text, from: 0, to: text.length, x0: 0, x1: text.length * 10, y0: 0, y1: 20 }] };
  // caja manual sobre las 15 primeras letras («Proyecto Zafiro»)
  const rv = applyReview([], lay, { manual: [{ x: 0, y: 0, w: 150, h: 20, all: true }] });
  assert.deepEqual(rv.ms.map((m) => m.value.toLowerCase().replace(/\s+/g, ' ')), ['proyecto zafiro', 'proyecto zafiro']);
  // y el mismo texto en otra página se tapa pasando los términos
  const other = applyReview([], { text: 'Otra página: Proyecto Zafiro', segs: [] }, null, rv.terms);
  assert.equal(other.ms.length, 1);
});

test('revisión previa en archivos no PDF: lo desmarcado se deja y listDetections lo ofrece', async () => {
  const { listDetections } = require('../src/core/files');
  const f = path.join(dir, 'rv.txt');
  fs.writeFileSync(f, 'DNI 12345678Z y correo ana@example.com, otra vez ana@example.com');
  const items = await listDetections(f, {});
  const mail = items.find((i) => i.type === 'EMAIL');
  assert.equal(mail.count, 2);
  const r = await processFile(f, new Session(), { skips: { [f]: [mail.key] } }, null);
  const out = fs.readFileSync(r.dest, 'utf8');
  assert.ok(out.includes('ana@example.com') && !out.includes('12345678Z'), out);
});

test('docx: conserva el formato, anonimiza entre trozos y limpia metadatos, miniatura y comentarios', async () => {
  const JSZip = require('jszip');
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types xmlns="x"><Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
  z.file('_rels/.rels', '<Relationships><Relationship Id="r1" Type="t" Target="docProps/thumbnail.jpeg"/></Relationships>');
  z.file('docProps/thumbnail.jpeg', 'JPG');
  z.file('docProps/core.xml', '<cp:coreProperties><dc:creator>Ana Ruiz</dc:creator></cp:coreProperties>');
  z.file('customXml/item1.xml', '<d>ana@example.com</d>');
  z.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>DNI 12345</w:t></w:r><w:r><w:t>678Z</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:docPr descr="foto de ana@example.com"/></w:drawing></w:r></w:p></w:body></w:document>');
  z.file('word/comments.xml', '<w:comments><w:comment w:author="Ana Ruiz"><w:p><w:r><w:t>nota</w:t></w:r></w:p></w:comment></w:comments>');
  const f = path.join(dir, 'fmt.docx');
  fs.writeFileSync(f, await z.generateAsync({ type: 'nodebuffer' }));
  const s = new Session();
  const r = await processFile(f, s, {}, null);
  const o = await JSZip.loadAsync(fs.readFileSync(r.dest));
  const doc = await o.file('word/document.xml').async('string');
  assert.ok(doc.includes('<w:b/>') && doc.includes('[DNI_1]') && !doc.includes('ana@example.com'), doc);
  assert.ok(!o.file('docProps/thumbnail.jpeg') && !o.file('customXml/item1.xml'));
  assert.ok(!(await o.file('word/comments.xml').async('string')).includes('Ana Ruiz'));
  assert.deepEqual(r.residues, []);
  const back = await restoreFile(r.dest, s, null);
  const rd = await (await JSZip.loadAsync(fs.readFileSync(back.dest))).file('word/document.xml').async('string');
  assert.ok(rd.includes('<w:b/>') && rd.includes('12345678Z'), rd);
});

test('modelo local de nombres: detecta nombres sueltos (solo si ANONI_NER_DIR apunta a un modelo instalado)', { skip: !process.env.ANONI_NER_DIR }, async () => {
  const { nerMatches } = require('../src/core/ner');
  const T = 'José Ramirez\nCONTACTO\nMálaga - España\nHola, soy María del Carmen Pérez y trabajo con Pedro Sánchez.';
  const ms = await nerMatches(T, process.env.ANONI_NER_DIR, []);
  const vals = ms.map((m) => m.value);
  assert.ok(['José Ramirez', 'Pedro Sánchez'].every((v) => vals.includes(v)), vals.join('|'));
  assert.ok(!vals.some((v) => /Málaga|CONTACTO/.test(v)));
});
