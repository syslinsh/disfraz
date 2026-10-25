'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Session, detect, anonymize, restore, leakCheck } = require('../src/core/anonymizer');
const { encrypt, decrypt } = require('../src/core/vault');
const { validDni, validIban, validLuhn, validCif } = require('../src/core/detectors');

const SAMPLE =
  'D. Ernesto Valcárcel Ruiz, con DNI 12345678Z y email ernesto@example.com, vive en Calle Mayor, 12, 3º B, 28013 Madrid. ' +
  'Teléfono +34 612 345 678. IBAN ES91 2100 0418 4502 0005 1332. Empresa: Inmuebles Herranz S.L. (CIF B12345674). ' +
  'Tarjeta 4111 1111 1111 1111. Repite: Ernesto Valcárcel Ruiz y 12345678-Z.';

test('validadores', () => {
  assert.ok(validDni('12345678Z'));
  assert.ok(!validDni('12345678A'));
  assert.ok(validIban('ES91 2100 0418 4502 0005 1332'));
  assert.ok(validLuhn('4111 1111 1111 1111'));
  assert.ok(validCif('B12345674'));
});

test('detecta los tipos principales', () => {
  const types = new Set(detect(SAMPLE).map((m) => m.type));
  for (const t of ['PERSONA', 'DNI', 'EMAIL', 'DIRECCION', 'CP', 'TELEFONO', 'IBAN', 'EMPRESA', 'CIF', 'TARJETA']) {
    assert.ok(types.has(t), `falta ${t}; hay ${[...types]}`);
  }
});

test('marcadores consistentes y sin fugas', () => {
  const s = new Session();
  const { text } = anonymize(SAMPLE, s);
  assert.ok(!/12345678/.test(text));
  assert.ok(!/ernesto@example/i.test(text));
  assert.strictEqual((text.match(/\[DNI_1\]/g) || []).length, 2); // mismo DNI con otro formato
  assert.strictEqual(leakCheck(text, s).length, 0);
});

test('restaurar devuelve el original y tolera corchetes perdidos', () => {
  const s = new Session();
  const { text } = anonymize(SAMPLE, s);
  assert.strictEqual(restore(text, s).text, SAMPLE.replace('12345678-Z', '12345678Z'));
  const r = restore('Hola DNI_1 y [dni_1], falta [PERSONA_99]', s);
  assert.ok(r.text.startsWith('Hola 12345678Z y 12345678Z'));
  assert.deepStrictEqual(r.unknown, ['[PERSONA_99]']);
});

test('términos personalizados', () => {
  const s = new Session();
  const { text } = anonymize('El proyecto Fénix es secreto', s, { custom: [{ term: 'Fénix', type: 'PROYECTO' }] });
  assert.strictEqual(text, 'El proyecto [PROYECTO_1] es secreto');
});

test('tipos desactivados no se anonimizan', () => {
  const s = new Session();
  const { text } = anonymize('ernesto@example.com', s, { enabled: { EMAIL: false } });
  assert.strictEqual(text, 'ernesto@example.com');
});

test('vault cifrado', () => {
  const s = new Session();
  anonymize(SAMPLE, s);
  const enc = encrypt(s.toJSON(), 'clave');
  assert.ok(!enc.includes('Valc'));
  const s2 = new Session(decrypt(enc, 'clave'));
  assert.strictEqual(s2.size, s.size);
  assert.throws(() => decrypt(enc, 'mala'), /Contraseña/);
});
