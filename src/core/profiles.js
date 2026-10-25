'use strict';
// Perfiles: tipos activos y términos que suelen necesitarse en cada contexto.
// `on` activa tipos que por defecto están apagados; `off` apaga los que no aplican.
const PROFILES = {
  general: { label: 'General', on: [], off: [], custom: [] },
  laboral: {
    label: 'Laboral / RR. HH.',
    on: ['IMPORTE', 'FECHA'],
    off: ['MATRICULA'],
    custom: [
      { term: 'convenio colectivo', type: 'REFERENCIA' }
    ]
  },
  legal: {
    label: 'Legal / despacho',
    on: ['FECHA'],
    off: [],
    custom: []
  },
  sanitario: {
    label: 'Sanitario',
    on: ['FECHA'],
    off: ['URL', 'MATRICULA'],
    custom: []
  },
  financiero: {
    label: 'Financiero / banca',
    on: ['IMPORTE'],
    off: [],
    custom: []
  }
};

/** Devuelve {enabled, custom} para un perfil, partiendo de los valores por defecto de los detectores. */
function profileConfig(id, types) {
  const p = PROFILES[id] || PROFILES.general;
  const enabled = {};
  for (const t of types) enabled[t.type] = t.defaultOn;
  for (const t of p.on) if (t in enabled) enabled[t] = true;
  for (const t of p.off) if (t in enabled) enabled[t] = false;
  return { enabled, custom: p.custom };
}

const list = () => Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label }));

module.exports = { PROFILES, profileConfig, list };
