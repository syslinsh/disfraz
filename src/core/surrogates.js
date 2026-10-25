'use strict';
// Subrogados realistas: un nombre parece un nombre, un DNI es un DNI válido, etc.
const crypto = require('crypto');
const { validIban } = require('./detectors');

const rnd = (n) => crypto.randomInt(n);
const pick = (a) => a[rnd(a.length)];
const digits = (n) => Array.from({ length: n }, () => rnd(10)).join('');

const NAMES_M = 'Hugo Mateo Leo Bruno Nicolás Gael Aitor Íñigo Cayetano Eugenio Teodoro Benito Anselmo Ildefonso Leandro Gaspar Rómulo Saturnino Evaristo Fulgencio'.split(' ');
const NAMES_F = 'Irene Candela Nerea Aitana Leire Vera Abril Maite Soledad Zoe Dafne Elvira Casilda Remedios Olalla Begoña Griselda Obdulia Venancia Clementina'.split(' ');
const SURNAMES = (
  'Aguirre Bermúdez Caballero Dávila Echevarría Fontán Galindo Hidalgo Iglesias Jaén Lozano Maldonado Nieto Olmedo Pastor Quintana ' +
  'Ribera Salvador Tejada Uriarte Valverde Zamora Arjona Barrios Campoy Delgado Escudero Frutos Garrido Heredia Ibáñez Juárez ' +
  'Lacalle Montero Navarrete Ocaña Paniagua Quesada Rebollo Sandoval Trujillo Urrutia Villalba Yáñez Zubiría Arévalo Benavides Cordero'
).split(' ');
const STREETS = 'del Olivar|de los Almendros|Mayor|del Pilar|de la Fuente|Real|de las Acacias|del Sol|de San Roque|de la Vega|del Molino|Nueva|de los Pinos'.split('|');
const DOMAINS = ['correo-demo.es', 'buzon-ficticio.com', 'mail-ejemplo.net', 'ejemplo-datos.org'];
const LETTERS_PLATE = 'BCDFGHJKLMNPRSTVWXYZ';
const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

function mimicDigits(orig) {
  let first = true;
  return orig.replace(/\d/g, () => {
    const d = first ? String(6 + rnd(2)) : String(rnd(10));
    first = false;
    return d;
  });
}

function fullName(orig) {
  const m = /^(?:D\.\/)?(Sr\.|Sra\.|Srta\.|D\.|Dña\.|D\.ª|Don|Doña|Dr\.|Dra\.|Ldo\.|Lda\.|Sres\.)\s+/.exec(orig);
  const title = m ? m[0] : '';
  const body = orig.slice(title.length);
  const upper = body === body.toUpperCase();
  const surnameFirst = /^[^,]+,\s*\S/.test(body);
  const female = /(Sra\.|Srta\.|Dña\.|D\.ª|Doña|Dra\.|Lda\.)/.test(title) || (!title && rnd(2) === 0);
  const first = pick(female ? NAMES_F : NAMES_M);
  const words = body.split(/\s+/).filter((w) => !/^(de|del|la|las|los|y|e)$/i.test(w)).length;
  const nSur = Math.max(1, Math.min(2, surnameFirst ? body.split(',')[0].trim().split(/\s+/).length : words - 1));
  const surs = Array.from({ length: nSur }, () => pick(SURNAMES));
  let out = surnameFirst ? `${surs.join(' ')}, ${first}` : `${first} ${surs.join(' ')}`;
  if (upper) out = out.toUpperCase();
  return title + out;
}

function dni(orig) {
  const nie = /^[XYZxyz]/.test(orig);
  const sepBefore = /[- ](?=[A-Za-z]$)/.test(orig) ? orig.match(/[- ](?=[A-Za-z]$)/)[0] : '';
  if (nie) {
    const p = 'XYZ'[rnd(3)];
    const num = digits(7);
    return p + num + sepBefore + DNI_LETTERS[Number('XYZ'.indexOf(p) + num) % 23];
  }
  const num = digits(8);
  return num + sepBefore + DNI_LETTERS[Number(num) % 23];
}

function cif(orig) {
  const L = orig.trim()[0].toUpperCase();
  const d = digits(7).split('').map(Number);
  let even = d[1] + d[3] + d[5];
  let odd = 0;
  for (const i of [0, 2, 4, 6]) {
    const x = d[i] * 2;
    odd += Math.floor(x / 10) + (x % 10);
  }
  const c = (10 - ((even + odd) % 10)) % 10;
  const ctrl = 'PQRSWN'.includes(L) ? 'JABCDEFGHI'[c] : String(c);
  return L + d.join('') + ctrl;
}

function iban(orig) {
  const bban = digits(20);
  const moved = bban + '142800'; // ES = 14 28
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  const check = String(98 - rem).padStart(2, '0');
  let out = 'ES' + check + bban;
  if (!validIban(out)) out = orig; // no debería ocurrir
  return /\s/.test(orig) ? out.replace(/(.{4})/g, '$1 ').trim() : out;
}

function luhnFix(digs) {
  let sum = 0;
  let alt = true;
  for (let i = digs.length - 1; i >= 0; i--) {
    let n = Number(digs[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return digs + String((10 - (sum % 10)) % 10);
}

function card(orig) {
  const ds = orig.replace(/\D/g, '');
  const core = luhnFix(ds[0] + digits(ds.length - 2));
  let i = 0;
  return orig.replace(/\d/g, () => core[i++]);
}

function shiftDate(orig, offsetDays) {
  const m = /^(\d{1,2})([\/.-])(\d{1,2})\2(\d{4}|\d{2})$/.exec(orig);
  if (!m) return null;
  const y = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
  const d = new Date(Date.UTC(y, Number(m[3]) - 1, Number(m[1])));
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + offsetDays);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const yy = m[4].length === 2 ? p(d.getUTCFullYear() % 100) : String(d.getUTCFullYear());
  return `${p(d.getUTCDate())}${m[2]}${p(d.getUTCMonth() + 1)}${m[2]}${yy}`;
}

/** Devuelve un subrogado para (type, value) o null si no hay generador (→ marcador). */
function generate(type, value, ctx = {}) {
  switch (type) {
    case 'PERSONA': return fullName(value);
    case 'DNI': return dni(value);
    case 'CIF': return cif(value);
    case 'IBAN': return iban(value);
    case 'TARJETA': return card(value);
    case 'EMAIL': {
      const n = fullName('x y z').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(' ');
      return `${n[1]}.${n[0]}${rnd(90) + 10}@${pick(DOMAINS)}`.replace(/[^a-z0-9.@-]/g, '');
    }
    case 'TELEFONO': return mimicDigits(value);
    case 'DIRECCION': {
      const kind = /^(C\/|Calle|Cl\.|Avda\.?|Avenida|Plaza|Pza\.?|Paseo|Camino|Ronda|Travesía|Carretera|Ctra\.?|Urbanización|Urb\.)/.exec(value);
      return `${kind ? kind[0] : 'Calle'} ${pick(STREETS)}, ${rnd(120) + 1}`;
    }
    case 'CP': return String(1 + rnd(52)).padStart(2, '0') + digits(3);
    case 'EMPRESA': {
      const suf = /(S\.?\s?L\.?\s?U?\.?|S\.?\s?A\.?\s?U?\.?|S\.?\s?L\.?\s?L\.?|S\.?\s?C\.?|C\.?B\.?)$/.exec(value);
      return `${pick(SURNAMES)} ${pick(SURNAMES)} ${suf ? suf[0] : 'S.L.'}`;
    }
    case 'MATRICULA': return digits(4) + ' ' + Array.from({ length: 3 }, () => LETTERS_PLATE[rnd(LETTERS_PLATE.length)]).join('');
    case 'IP': return `10.${rnd(256)}.${rnd(256)}.${rnd(254) + 1}`;
    case 'URL': return `https://ejemplo-ficticio.com/${digits(6)}`;
    case 'SECRETO': return value.slice(0, 3) + Array.from({ length: Math.max(value.length - 3, 8) }, () => pick('abcdefghijklmnopqrstuvwxyz0123456789')).join('');
    case 'FECHA': return shiftDate(value, ctx.dateOffset || 0);
    default: return null;
  }
}

module.exports = { generate };
