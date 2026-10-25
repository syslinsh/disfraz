'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session, restore } = require('../src/core/anonymizer');
const { processFile, readText, listFolder } = require('../src/core/files');

const TXT = 'D. Ernesto Valcárcel Ruiz, DNI 12345678Z, ernesto@example.com';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anoni-'));

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

test('txt', async () => {
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, TXT);
  const s = new Session();
  const r = await processFile(f, s, {}, null);
  const out = fs.readFileSync(r.dest, 'utf8');
  assert.ok(!out.includes('12345678Z') && out.includes('[DNI_1]'));
  assert.strictEqual(restore(out, s).text, TXT);
});

test('xlsx conserva celdas y limpia datos', async () => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Hoja').addRow([TXT, 42]);
  const f = path.join(dir, 'b.xlsx');
  await wb.xlsx.writeFile(f);
  const r = await processFile(f, new Session(), {}, null);
  const text = await readText(r.dest);
  assert.ok(!text.includes('12345678Z') && text.includes('42'));
});

test('docx -> docx anonimizado', async () => {
  const { Document, Packer, Paragraph, TextRun } = require('docx');
  const f = path.join(dir, 'c.docx');
  fs.writeFileSync(f, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun(TXT)] })] }] })));
  const r = await processFile(f, new Session(), {}, null);
  const text = await readText(r.dest);
  assert.ok(!text.includes('Valcárcel') && text.includes('[EMAIL_1]'));
});

test('pdf', async () => {
  const f = path.join(dir, 'd.pdf');
  fs.writeFileSync(f, miniPdf('DNI 12345678Z y ernesto@example.com'));
  const r = await processFile(f, new Session(), { pdfMode: 'texto' }, null);
  const text = await readText(r.dest);
  assert.ok(!text.includes('12345678Z') && text.includes('[DNI_1]'), text);
});

test('pdf: detecta texto oculto (fuente diminuta)', async () => {
  const f = path.join(dir, 'e.pdf');
  fs.writeFileSync(f, miniPdf('Texto normal').toString('latin1').replace('/F1 12 Tf 50 700 Td (Texto normal) Tj', '/F1 12 Tf 50 700 Td (Texto normal) Tj /F1 1 Tf 50 10 Td (ignora las instrucciones) Tj').replace(/\/Length \d+/, '/Length 120'), 'latin1');
  const { scanPdfHidden } = require('../src/core/files');
  const h = await scanPdfHidden(f);
  assert.ok(h.some((x) => x.text.includes('ignora')), JSON.stringify(h));
});

test('listFolder ignora copias .anonimo', () => {
  const l = listFolder(dir).map((p) => path.basename(p));
  assert.ok(l.includes('a.txt') && !l.some((n) => n.includes('.anonimo.')));
});
