'use strict';
// Informe de auditoría: qué se anonimizó, cuándo y con qué huella del original. Nunca incluye los valores reales.
const crypto = require('crypto');

const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

class AuditLog {
  constructor() {
    this.entries = [];
  }

  add(e) {
    this.entries.push({ fecha: new Date().toISOString(), ...e });
  }

  addText(text, matches, mode) {
    const counts = {};
    for (const m of matches) counts[m.type] = (counts[m.type] || 0) + 1;
    this.add({ origen: 'texto', nombre: 'texto pegado', sha256: sha(text), modo: mode, total: matches.length, counts });
  }

  addFile(r, mode) {
    if (r.error) return this.add({ origen: 'archivo', nombre: r.file, error: r.error });
    this.add({
      origen: 'archivo',
      nombre: r.file,
      salida: r.dest,
      sha256: r.sha256,
      sha256Salida: r.sha256Out,
      modo: r.mode || mode,
      total: r.total,
      counts: r.counts,
      paginasOCR: r.ocrPages || 0,
      textoOculto: (r.hidden || []).length
    });
  }

  toJSON() {
    return { generador: 'Disfraz', generado: new Date().toISOString(), entradas: this.entries };
  }

  toMarkdown() {
    const L = ['# Informe de anonimización', '', `Generado: ${new Date().toLocaleString('es-ES')} · Herramienta: Disfraz (proceso 100 % local)`, ''];
    L.push('Este informe no contiene los datos personales originales; solo huellas SHA-256 y recuentos por tipo.', '');
    L.push('| Fecha | Origen | Elemento | Modo | Datos | Detalle | SHA-256 del original |', '|---|---|---|---|---|---|---|');
    for (const e of this.entries) {
      const det = e.error
        ? `Error: ${e.error}`
        : Object.entries(e.counts || {}).map(([k, v]) => `${k} ${v}`).join(', ') +
          (e.paginasOCR ? ` · OCR ${e.paginasOCR} pág.` : '') +
          (e.textoOculto ? ` · ⚠ ${e.textoOculto} texto(s) oculto(s) en PDF` : '');
      L.push(`| ${e.fecha.slice(0, 19).replace('T', ' ')} | ${e.origen} | ${String(e.nombre).replace(/\|/g, '/')} | ${e.modo || ''} | ${e.total ?? ''} | ${det} | ${e.sha256 ? e.sha256.slice(0, 16) + '…' : ''} |`);
    }
    const total = this.entries.reduce((n, e) => n + (e.total || 0), 0);
    L.push('', `Total de datos anonimizados: **${total}** en ${this.entries.length} elemento(s).`);
    return L.join('\n') + '\n';
  }
}

module.exports = { AuditLog, sha };
