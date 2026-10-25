'use strict';
// Detectores de datos personales (España/UE). Todo se ejecuta en local.

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

function validDni(raw) {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  const m = /^(\d{8})([A-Z])$/.exec(s);
  return !!m && DNI_LETTERS[Number(m[1]) % 23] === m[2];
}

function validNie(raw) {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  const m = /^([XYZ])(\d{7})([A-Z])$/.exec(s);
  if (!m) return false;
  const n = Number('XYZ'.indexOf(m[1]) + m[2]);
  return DNI_LETTERS[n % 23] === m[3];
}

function validCif(raw) {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  const m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(s);
  if (!m) return false;
  const d = m[2].split('').map(Number);
  let even = d[1] + d[3] + d[5];
  let odd = 0;
  for (const i of [0, 2, 4, 6]) {
    const x = d[i] * 2;
    odd += Math.floor(x / 10) + (x % 10);
  }
  const ctrl = (10 - ((even + odd) % 10)) % 10;
  const letter = 'JABCDEFGHI'[ctrl];
  return m[3] === String(ctrl) || m[3] === letter;
}

function validIban(raw) {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const c of v) rem = (rem * 10 + Number(c)) % 97;
  }
  return rem === 1;
}

function validLuhn(raw) {
  const s = raw.replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(s)) return false;
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = Number(s[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const CAP = "[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+(?:['-][A-ZÁÉÍÓÚÜÑ]?[a-záéíóúüñ]+)?";
const CONNECT = '(?:de|del|la|las|los|y|e|da|di|van|von)';
const NAME_SEQ = `${CAP}(?:\\s+(?:${CONNECT}\\s+)?${CAP}){0,3}`;

const FIRST_NAMES = (
  'Antonio José Manuel Francisco David Juan Javier Daniel Carlos Miguel Rafael Pedro Ángel Alejandro Fernando ' +
  'Luis Sergio Pablo Jorge Alberto Álvaro Adrián Diego Raúl Enrique Ramón Vicente Iván Rubén Óscar Andrés Joaquín ' +
  'Santiago Eduardo Víctor Roberto Jesús Ignacio Marcos Mario Hugo Martín Lucas Gonzalo Ismael Ernesto Tomás Samuel ' +
  'María Carmen Josefa Isabel Ana Dolores Pilar Teresa Laura Cristina Marta Lucía Elena Francisca Paula Sara Rosa ' +
  'Raquel Mercedes Beatriz Patricia Concepción Silvia Rocío Natalia Irene Julia Mónica Sonia Nuria Inés Alicia ' +
  'Andrea Claudia Eva Sofía Carla Noelia Lorena Yolanda Gloria Amparo Esther Verónica Sandra Alba Marina Olga Lidia ' +
  'Mohamed Ahmed Ali Youssef Omar Fatima Aisha Marco Giuseppe Pierre Jean Peter John Michael Anna Maria Ion Andrei'
).split(/\s+/);

const FIRST_NAMES_RE = FIRST_NAMES.join('|');

// Cada detector: type, label, re (global), validate?, priority (más alto gana en solapes), group (para la UI)
const DETECTORS = [
  {
    type: 'SECRETO',
    label: 'Claves y secretos',
    priority: 100,
    re: /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g
  },
  {
    type: 'EMAIL',
    label: 'Correos electrónicos',
    priority: 95,
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
  },
  {
    type: 'URL',
    label: 'Enlaces web',
    priority: 90,
    re: /\bhttps?:\/\/[^\s<>"')\]]+/g
  },
  {
    type: 'IBAN',
    label: 'IBAN / cuentas bancarias',
    priority: 90,
    re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g,
    validate: validIban
  },
  {
    type: 'TARJETA',
    label: 'Tarjetas de pago',
    priority: 85,
    re: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    validate: validLuhn
  },
  {
    type: 'DNI',
    label: 'DNI / NIE',
    priority: 88,
    re: /\b(?:\d{8}[- ]?[A-Za-z]|[XYZxyz][- ]?\d{7}[- ]?[A-Za-z])\b/g,
    validate: (v) => validDni(v) || validNie(v)
  },
  {
    // tras la etiqueta «DNI/NIE:» se tapa aunque la letra falte o no cuadre (típico de datos mal escritos)
    type: 'DNI',
    label: 'DNI / NIE',
    priority: 87,
    re: /(?<=\b(?:DNI|NIE|NIF)(?:\s*\/\s*(?:DNI|NIE|NIF))?[:\s.-]{1,3})[XYZxyz]?\d{7,8}[A-Za-z]?\b/g
  },
  {
    type: 'CIF',
    label: 'CIF de empresas',
    priority: 86,
    re: /\b[ABCDEFGHJNPQRSUVW][- ]?\d{7}[- ]?[0-9A-J]\b/g,
    validate: validCif
  },
  {
    type: 'TELEFONO',
    label: 'Teléfonos',
    priority: 70,
    re: /(?<![\d.])(?:(?:\+|00)\d{2}[ .-]?)?[6-9]\d{2}(?:[ .-]?\d{2}){3}(?![\d])|(?<![\d.])(?:(?:\+|00)\d{2}[ .-]?)?[6-9]\d{2}[ .-]\d{3}[ .-]\d{3}(?![\d])/g
  },
  {
    // tras «Teléfono:», «Móvil:»… se tapa cualquier número, aunque tenga más o menos cifras de las normales
    type: 'TELEFONO',
    label: 'Teléfonos',
    priority: 69,
    re: /(?<=\b(?:tel[eé]fono(?:\s+de\s+contacto)?|tel\.?|m[oó]vil|fijo|whatsapp)[:\s.-]{1,3})\+?\d[\d .-]{6,14}\d\b/gi
  },
  {
    type: 'IP',
    label: 'Direcciones IP',
    priority: 60,
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
  },
  {
    type: 'MATRICULA',
    label: 'Matrículas',
    priority: 65,
    re: /\b\d{4}[ -]?[BCDFGHJKLMNPRSTVWXYZ]{3}\b/g
  },
  {
    type: 'DIRECCION',
    label: 'Direcciones postales',
    priority: 55,
    re: new RegExp(
      "\\b(?:C\\/|[Cc]alle|[Cc]l\\.|[Aa]vda\\.?|[Aa]venida|[Pp]laza|[Pp]za\\.?|[Pp]aseo|[Cc]amino|[Rr]onda|[Tt]ravesía|[Cc]arretera|[Cc]tra\\.?|[Uu]rbanización|[Uu]rb\\.)\\s+" +
        "[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9.'’ -]{2,50}?" +
        ",?\\s*(?:n[ºo°.]*\\s*)?\\d{1,4}[A-Za-zº]?" +
        "(?:\\s*,?\\s*(?:\\d{1,2}[ºª°]?\\s*[A-Za-z]?\\b|bajo|bajos|entresuelo|piso\\s+\\d+[ºª]?(?:\\s*[A-Za-z])?|puerta\\s+\\w+))?",
      'g'
    )
  },
  {
    // lo que sigue a «Dirección:» / «Domicilio:» hasta el final de la línea
    type: 'DIRECCION',
    label: 'Direcciones postales',
    priority: 54,
    re: /(?<=\b(?:direcci[oó]n|domicilio)(?:\s+(?:postal|completa|de\s+\w+))?\s*:[ \t]*)[^\s,;][^\n\r]{4,90}?(?=[ \t]*(?:\r?\n|$))/gim
  },
  {
    type: 'CP',
    label: 'Códigos postales',
    priority: 50,
    re: /(?<=\b(?:C\.?P\.?|código postal)[:\s]\s?)(?:0[1-9]|[1-4]\d|5[0-2])\d{3}\b|\b(?:0[1-9]|[1-4]\d|5[0-2])\d{3}(?=\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/g
  },
  {
    type: 'EMPRESA',
    label: 'Empresas (S.L., S.A.…)',
    priority: 58,
    re: new RegExp(
      `\\b(?:${CAP}(?:\\s+(?:${CONNECT}\\s+)?${CAP}|\\s+[A-ZÁÉÍÓÚÑ]{2,}){0,4})\\s*,?\\s+(?:S\\.?\\s?L\\.?\\s?U?\\.?|S\\.?\\s?A\\.?\\s?U?\\.?|S\\.?\\s?L\\.?\\s?L\\.?|S\\.?\\s?C\\.?|C\\.?B\\.?)(?=[\\s,.;:)]|$)`,
      'g'
    )
  },
  {
    type: 'PERSONA',
    label: 'Nombres de personas',
    priority: 45,
    // 1) tras tratamiento (D., Dña., Sr., Dr.…)  2) nombre de pila + apellidos  3) APELLIDOS, NOMBRE en mayúsculas
    re: new RegExp(
      // tratamiento + nombre aunque los apellidos vayan en minúscula, si cierran la línea («D./Dña. Almudena gil aguilar»)
      `\\b(?:D\\.\\/)?(?:Sr\\.|Sra\\.|Srta\\.|D\\.|Dña\\.|D\\.ª|Don|Doña|Dr\\.|Dra\\.|Ldo\\.|Lda\\.)\\s+${CAP}(?:\\s+[a-záéíóúüñ]{3,}){1,2}(?=[ \\t]*(?:\\r?\\n|$))` +
        `|\\b(?:D\\.\\/)?(?:(?:Sr\\.|Sra\\.|Srta\\.|D\\.|Dña\\.|D\\.ª|Don|Doña|Dr\\.|Dra\\.|Ldo\\.|Lda\\.|Sres\\.)\\s+${NAME_SEQ})` +
        `|\\b(?:${FIRST_NAMES_RE})(?:\\s+(?:${CONNECT}\\s+)?${CAP}){1,3}\\b` +
        `|\\b[A-ZÁÉÍÓÚÑ]{3,}(?:\\s+[A-ZÁÉÍÓÚÑ]{2,})?,\\s*[A-ZÁÉÍÓÚÑ]{3,}(?:\\s+[A-ZÁÉÍÓÚÑ]{2,})?\\b`,
      'gm'
    )
  },
  {
    type: 'NSS',
    label: 'Nº Seguridad Social',
    priority: 88,
    re: /\b\d{2}[\s\/-]?\d{8}[\s\/-]?\d{2}\b/g,
    validate: (v) => {
      const d = v.replace(/\D/g, '');
      if (d.length !== 12) return false;
      const n = Number(d.slice(0, 2) + d.slice(2, 10).padStart(8, '0'));
      return n % 97 === Number(d.slice(10));
    }
  },
  {
    type: 'REFERENCIA',
    label: 'Nº de expediente / autos / historia clínica',
    priority: 60,
    re: /\b(?:autos|procedimiento|expediente|exp\.|NIG|rollo|diligencias|historia\s+cl[ií]nica|NHC|factura|pedido|contrato|p[oó]liza|n[ºo°]\s*(?:de\s+)?(?:colegiado|afiliaci[oó]n|p[oó]liza|contrato|cliente|factura|pedido))\s*(?:n\.?[ºo°]?\.?\s*)?[:#]?\s*[A-Z0-9][\w\/.-]{2,}\d\b/gi
  },
  {
    type: 'FECHA',
    label: 'Fechas',
    priority: 40,
    defaultOn: false,
    re: /\b(?:\d{1,2}[\/.-]\d{1,2}[\/.-](?:\d{4}|\d{2})|\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+\d{4})?)\b/gi
  },
  {
    type: 'IMPORTE',
    label: 'Importes en euros',
    priority: 35,
    defaultOn: false,
    re: /\b\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?\s?(?:€|euros?|EUR)\b|€\s?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?/gi
  }
];

const TYPES = DETECTORS.filter((d, i) => DETECTORS.findIndex((x) => x.type === d.type) === i).map((d) => ({
  type: d.type,
  label: d.label,
  defaultOn: d.defaultOn !== false
}));

module.exports = { DETECTORS, TYPES, validDni, validNie, validCif, validIban, validLuhn };
