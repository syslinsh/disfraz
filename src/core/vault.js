'use strict';
const crypto = require('crypto');

// Guarda el mapa de marcadores cifrado con contraseña (scrypt + AES-256-GCM).
function encrypt(obj, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: 'anoni-lin-vault',
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  });
}

function decrypt(json, password) {
  const f = JSON.parse(json);
  if (f.format !== 'anoni-lin-vault') throw new Error('Archivo de sesión no válido');
  const key = crypto.scryptSync(password, Buffer.from(f.salt, 'base64'), 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
  d.setAuthTag(Buffer.from(f.tag, 'base64'));
  try {
    const out = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    throw new Error('Contraseña incorrecta o archivo dañado');
  }
}

module.exports = { encrypt, decrypt };
