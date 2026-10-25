'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Session, detect, apply, restore, leakCheckValues } = require('../src/core/anonymizer');
const { validDni, validIban, validCif } = require('../src/core/detectors');

const T = 'D. Ernesto Valcárcel Ruiz, DNI 12345678Z, ernesto@example.com, IBAN ES9121000418450200051332, CIF B12345674';

test('modo realista: sustituye con datos válidos y restaura', () => {
  const s = new Session({ mode: 'realista' });
  const ms = detect(T);
  const out = apply(T, ms, s);
  assert.ok(!out.includes('12345678Z') && !out.includes('Valcárcel') && !out.includes('[DNI'));
  const dni = s.items.find((i) => i.type === 'DNI').placeholder;
  assert.ok(validDni(dni));
  assert.ok(validIban(s.items.find((i) => i.type === 'IBAN').placeholder));
  assert.ok(validCif(s.items.find((i) => i.type === 'CIF').placeholder));
  assert.strictEqual(restore(out, s).text, T);
  assert.strictEqual(leakCheckValues(out, ms).length, 0);
});

test('modo realista: mismo dato, mismo sustituto; sobrevive a guardar/cargar', () => {
  const s = new Session({ mode: 'realista' });
  const a = apply('DNI 12345678Z y otra vez 12345678Z', detect('DNI 12345678Z y otra vez 12345678Z'), s);
  const [x, y] = a.match(/\d{8}[A-Z]/g);
  assert.strictEqual(x, y);
  const s2 = new Session(JSON.parse(JSON.stringify(s.toJSON())));
  assert.strictEqual(s2.mode, 'realista');
  assert.ok(restore(a, s2).text.includes('12345678Z'));
});

test('modo irreversible: no guarda nada', () => {
  const s = new Session({ mode: 'irreversible' });
  const out = apply(T, detect(T), s);
  assert.ok(out.includes('[DNI]') && !out.includes('12345678Z'));
  assert.strictEqual(s.size, 0);
});
