'use strict';
const $ = (id) => document.getElementById(id);
const INSTR =
  'Los marcadores entre corchetes como [PERSONA_1], [DNI_1] o [EMAIL_2] sustituyen datos personales reales. ' +
  'Trátalos como nombres propios opacos: no intentes adivinarlos y cópialos EXACTAMENTE igual (con corchetes) en tu respuesta.\n\n---\n';

let matches = [];
let included = new Set();
let revealed = false;
let pending = [];
const INSTR_REAL =
  'Los datos personales de este texto son ficticios (sustituidos). Trátalos como reales dentro del texto y cópialos EXACTAMENTE igual en tu respuesta.\n\n---\n';
const instr = () => ($('mode').value === 'realista' ? INSTR_REAL : INSTR);
let lastSession = { size: 0, items: [] };

// ---- Aspecto: tema claro/oscuro, colores por tipo, avisos
const hues = {};
const hashHue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const hueOf = (s) => (s in hues ? hues[s] : hashHue(s));
const tint = (el, key) => (el.style.setProperty('--h', hueOf(key)), el);
function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function theme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem('theme', t);
  } catch {
    /* sin almacenamiento: se queda en el tema del sistema */
  }
}
try {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* idem */
}
$('btnTheme').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
  theme(dark ? 'light' : 'dark');
};
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
}
const extOf = (f) => (f.match(/\.([a-z0-9]+)$/i) || [, '?'])[1].toLowerCase();

document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button,.tab').forEach((e) => e.classList.remove('on'));
    b.classList.add('on');
    $('tab-' + b.dataset.tab).classList.add('on');
  })
);

function opts() {
  const enabled = {};
  document.querySelectorAll('#typeList input').forEach((c) => (enabled[c.dataset.t] = c.checked));
  const custom = $('customTerms').value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [term, type] = l.split('=').map((s) => s.trim());
      return { term, type: (type || 'PERSONALIZADO').toUpperCase().replace(/[^A-Z]/g, '') || 'PERSONALIZADO' };
    });
  return { enabled, custom, pdfMode: $('pdfMode').value, ner: $('chkNer').checked };
}
const sigOf = (o) => JSON.stringify({ e: o.enabled, c: o.custom, n: !!o.ner });

// ---- Revisión manual de PDF: reviews[ruta] = { sig, pages: {n: {excluded:[ids], manual:[{x,y,w,h}]}} }
const reviews = {};
function pendingCell(f) {
  const c = document.createElement('td');
  c.append(mk('span', 'state', 'Pendiente'));
  if (/\.pdf$/i.test(f) || !/\.(png|jpe?g)$/i.test(f)) {
    const pdf = /\.pdf$/i.test(f);
    const a = document.createElement('a');
    a.textContent = (pdf ? reviews[f] : skips[f]) ? ' · Revisado ✓ (editar)' : ' · Revisar';
    a.onclick = () => (pdf ? openReview(f, a) : openList(f, a));
    c.append(a);
  }
  return c;
}

// Revisión de archivos que no son PDF: lista de valores detectados; lo desmarcado se deja tal cual. skips[ruta] = { sig, keys: ['TIPO|valor'] }
const skips = {};
async function openList(file, link) {
  link.textContent = ' · Analizando…';
  const o = opts();
  const r = await api.fileDetections(file, o);
  if (r.error) {
    link.textContent = ' · Error: ' + r.error;
    return;
  }
  const off = new Set(skips[file] && skips[file].sig === sigOf(o) ? skips[file].keys : []);
  $('rlTitle').textContent = file.split(/[\\/]/).pop();
  $('rlItems').replaceChildren(
    ...(r.items.length ? r.items : [{ type: '', value: 'No se detectó nada', key: '', count: 0 }]).map((it) => {
      const row = document.createElement('label');
      row.className = 'rl-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !off.has(it.key);
      cb.disabled = !it.key;
      cb.onchange = () => (cb.checked ? off.delete(it.key) : off.add(it.key));
      const tag = tint(mk('span', 'tag', it.type), it.type);
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = it.value + (it.count > 1 ? ` (×${it.count})` : '');
      row.append(cb, tag, v);
      return row;
    })
  );
  $('rvList').classList.remove('hidden');
  const label = () => (link.textContent = skips[file] ? ' · Revisado ✓ (editar)' : ' · Revisar');
  const close = () => $('rvList').classList.add('hidden');
  $('rlCancel').onclick = () => (close(), label());
  $('rlOk').onclick = () => {
    if (off.size) skips[file] = { sig: sigOf(o), keys: [...off] };
    else delete skips[file];
    close();
    label();
  };
}
async function openReview(file, link) {
  link.textContent = ' · Analizando…';
  const o = opts();
  const r = await api.pdfAnalyze(file, o);
  if (r.error) {
    link.textContent = ' · Error: ' + r.error;
    return;
  }
  const cur = reviews[file] && reviews[file].sig === sigOf(o) ? reviews[file] : { sig: sigOf(o), pages: {} };
  const state = {};
  r.pages.forEach((_, i) => {
    const p = cur.pages[i + 1] || {};
    state[i + 1] = { excluded: new Set(p.excluded || []), manual: [...(p.manual || [])] };
  });
  $('rvTitle').textContent = file.split(/[\/]/).pop();
  const host = $('rvPages');
  const draw = () =>
    host.replaceChildren(
      ...r.pages.map((pg, i) => {
        const st = state[i + 1];
        const wrap = document.createElement('div');
        wrap.className = 'rv-page';
        wrap.style.aspectRatio = pg.w + ' / ' + pg.h;
        const img = document.createElement('img');
        img.src = pg.img;
        img.draggable = false;
        wrap.append(img);
        const place = (el, b) => {
          el.style.left = (b.x / pg.w) * 100 + '%';
          el.style.top = (b.y / pg.h) * 100 + '%';
          el.style.width = (b.w / pg.w) * 100 + '%';
          el.style.height = (b.h / pg.h) * 100 + '%';
        };
        for (const bx of pg.boxes)
          for (const rc of bx.rects) {
            const d = document.createElement('div');
            d.className = 'rv-box' + (st.excluded.has(bx.id) ? ' off' : '');
            d.title = bx.type + ': ' + bx.value;
            place(d, rc);
            d.onmousedown = (e) => e.stopPropagation();
            d.onclick = () => {
              st.excluded.has(bx.id) ? st.excluded.delete(bx.id) : st.excluded.add(bx.id);
              draw();
            };
            wrap.append(d);
          }
        st.manual.forEach((m, k) => {
          const d = document.createElement('div');
          d.className = 'rv-box manual';
          d.title = 'Caja manual (clic para quitarla)';
          place(d, m);
          d.onmousedown = (e) => e.stopPropagation();
          d.onclick = () => (st.manual.splice(k, 1), draw());
          wrap.append(d);
        });
        wrap.onmousedown = (e) => {
          const rect = wrap.getBoundingClientRect();
          const px = (ev) => [((ev.clientX - rect.left) / rect.width) * pg.w, ((ev.clientY - rect.top) / rect.height) * pg.h];
          const [x0, y0] = px(e);
          const ghost = document.createElement('div');
          ghost.className = 'rv-box manual';
          wrap.append(ghost);
          const move = (ev) => {
            const [x1, y1] = px(ev);
            place(ghost, { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
          };
          const up = (ev) => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            const [x1, y1] = px(ev);
            const b = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
            if (b.w > 8 && b.h > 8) st.manual.push({ ...b, all: $('rvAll').checked });
            draw();
          };
          document.addEventListener('mousemove', move);
          document.addEventListener('mouseup', up);
          e.preventDefault();
        };
        const lab = document.createElement('div');
        lab.className = 'rv-num';
        lab.textContent = 'Página ' + (i + 1);
        wrap.append(lab);
        return wrap;
      })
    );
  draw();
  $('review').classList.remove('hidden');
  const close = () => $('review').classList.add('hidden');
  $('rvCancel').onclick = () => (close(), (link.textContent = reviews[file] ? ' · Revisado ✓ (editar)' : ' · Revisar'));
  $('rvClear').onclick = () => (Object.values(state).forEach((s) => (s.manual = [])), draw());
  $('rvOk').onclick = () => {
    const pages = {};
    for (const [n, s] of Object.entries(state)) if (s.excluded.size || s.manual.length) pages[n] = { excluded: [...s.excluded], manual: s.manual };
    reviews[file] = { sig: sigOf(o), pages };
    link.textContent = ' · Revisado ✓ (editar)';
    close();
  };
}

function applyConfig(cfg) {
  document.querySelectorAll('#typeList input').forEach((c) => c.dataset.t in cfg.enabled && (c.checked = cfg.enabled[c.dataset.t]));
  const own = $('customTerms').value.split(/\r?\n/).filter((l) => l.trim() && !cfg.custom.some((c) => l.startsWith(c.term)));
  $('customTerms').value = [...own, ...cfg.custom.map((c) => `${c.term} = ${c.type}`)].join('\n');
}

function renderSession(s) {
  lastSession = s;
  if (s.mode) $('mode').value = s.mode;
  $('sessBadge').textContent = s.size;
  const tb = $('sessTable').querySelector('tbody');
  tb.replaceChildren(
    ...s.items.map((i) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.textContent = i.placeholder;
      const b = document.createElement('td');
      b.textContent = revealed ? i.value : '••••••••';
      tr.append(a, b);
      return tr;
    })
  );
}

// ---- Anonimizar
function showInput(on) {
  $('inView').classList.toggle('hidden', !on);
  $('inText').classList.toggle('hidden', on);
  $('btnEdit').classList.toggle('hidden', !on);
}
function showOutput(on) {
  $('outView').classList.toggle('hidden', !on);
  $('outText').classList.toggle('hidden', on);
  $('outHint').classList.toggle('hidden', !on);
}
// original con los datos detectados resaltados por tipo; clic = incluir/excluir
const checks = new Map();
function renderInput() {
  const text = $('inText').value;
  const parts = [];
  let pos = 0;
  for (const m of matches) {
    if (m.start < pos) continue;
    if (m.start > pos) parts.push(text.slice(pos, m.start));
    const s = tint(mk('span', 'hl' + (included.has(m.id) ? '' : ' off'), text.slice(m.start, m.end)), m.type);
    s.title = m.type + ' · clic para ' + (included.has(m.id) ? 'dejarlo sin tocar' : 'incluirlo');
    s.onclick = () => {
      included.has(m.id) ? included.delete(m.id) : included.add(m.id);
      checks.get(m.id).checked = included.has(m.id);
      renderInput();
    };
    parts.push(s);
    pos = m.end;
  }
  parts.push(text.slice(pos));
  $('inView').replaceChildren(...parts);
}
function renderChips() {
  const by = {};
  matches.forEach((m) => (by[m.type] = (by[m.type] || 0) + 1));
  $('sumChips').replaceChildren(
    ...Object.entries(by).map(([t, n]) => {
      const c = tint(mk('span', 'chip'), t);
      c.append(mk('b', null, n), t);
      return c;
    })
  );
}
$('btnPasteIn').onclick = async () => {
  showInput(false);
  $('inText').value = await api.paste();
};
$('btnEdit').onclick = () => (showInput(false), $('inText').focus());
$('btnDetect').onclick = async () => {
  const r = await api.detect($('inText').value, opts());
  if (r.error) return ($('detInfo').textContent = r.error);
  matches = r.matches;
  included = new Set(matches.map((m) => m.id));
  checks.clear();
  $('detList').replaceChildren(
    ...matches.map((m) => {
      const d = mk('div', 'det');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = true;
      checks.set(m.id, c);
      c.onchange = () => ((c.checked ? included.add(m.id) : included.delete(m.id)), renderInput());
      d.append(c, tint(mk('span', 'tag', m.type), m.type), mk('span', 'v', m.value));
      return d;
    })
  );
  renderChips();
  $('detInfo').textContent = matches.length ? `${matches.length} datos detectados` : 'No se detectó nada';
  showInput(matches.length > 0);
  if (matches.length) {
    renderInput();
    $('btnApply').click();
  }
};
$('btnApply').onclick = async () => {
  const sel = matches.filter((m) => included.has(m.id));
  const r = await api.apply($('inText').value, sel);
  const pre = sel.length && $('chkInstr').checked && $('mode').value !== 'irreversible' ? instr() : '';
  $('outText').value = pre + r.text;
  const parts = [];
  if (pre) parts.push(mk('span', 'pre', pre.replace(/\n\n---\n$/, '')));
  for (const s of r.segs) {
    if (!s.type) parts.push(s.t);
    else {
      const e = tint(mk('span', 'hl out', s.t), s.type);
      e.dataset.real = s.type + ': ' + s.value;
      parts.push(e);
    }
  }
  $('outView').replaceChildren(...parts);
  showOutput(true);
  renderSession(r.session);
  const lb = $('leakBox');
  if (r.leaks.length) {
    lb.className = 'notice';
    lb.textContent = `⚠ Quedan ${r.leaks.length} valores reales en el texto (probablemente desmarcados): ` + r.leaks.map((l) => l.type).join(', ');
  } else {
    lb.className = 'notice ok';
    lb.textContent = '✓ Comprobación de fugas: ningún dato conocido queda en el texto.';
  }
};
$('mode').onchange = async () => renderSession(await api.setMode($('mode').value));
$('btnCopyOut').onclick = () => ($('outText').value ? (api.copy($('outText').value), toast('Copiado ✓')) : toast('Todavía no hay nada que copiar'));
$('inText').addEventListener('input', () => showInput(false));
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.key === 'Enter')) return;
  const tab = document.querySelector('.tab.on').id;
  if (tab === 'tab-anon') $('btnDetect').click();
  else if (tab === 'tab-rest') $('btnRestore').click();
  else if (tab === 'tab-files' && !$('btnRun').disabled) $('btnRun').click();
});

// ---- Restaurar
$('btnPasteAi').onclick = async () => ($('aiText').value = await api.paste());
$('btnRestore').onclick = async () => {
  const r = await api.restore($('aiText').value);
  $('restText').value = r.text;
  $('restInfo').textContent = `${r.restored} datos restaurados`;
  const w = $('restWarn');
  if (r.unknown.length) {
    w.className = 'notice';
    w.textContent = 'Marcadores que no están en esta sesión (¿inventados por la IA o de otra sesión?): ' + r.unknown.join(' ');
  } else w.className = 'notice hidden';
};
$('btnCopyRest').onclick = () => ($('restText').value ? (api.copy($('restText').value), toast('Copiado ✓')) : toast('Todavía no hay nada que copiar'));

// ---- Archivos
function setPending(files) {
  pending = [...new Set(files)];
  $('fileTable').querySelector('tbody').replaceChildren(
    ...pending.map((f) => {
      const tr = document.createElement('tr');
      tr.dataset.f = f;
      const a = document.createElement('td');
      const name = f.split(/[\\/]/).pop();
      const fc = mk('div', 'fcell');
      const fn = mk('div', 'fname');
      fn.append(mk('b', null, name), mk('small', null, f.slice(0, f.length - name.length)));
      fn.title = f;
      fc.append(tint(mk('span', 'fext', extOf(f).toUpperCase()), extOf(f)), fn);
      a.append(fc);
      const b = document.createElement('td');
      b.textContent = '—';
      const c = pendingCell(f);
      tr.append(a, b, c);
      return tr;
    })
  );
  $('btnRun').disabled = !pending.length;
  $('fileEmpty').classList.toggle('hidden', pending.length > 0);
  $('progWrap').classList.add('hidden');
  $('fileInfo').textContent = pending.length ? `${pending.length} archivo${pending.length > 1 ? 's' : ''} listo${pending.length > 1 ? 's' : ''} para anonimizar` : '';
}
const setState = (tr, cls, text) => {
  const s = mk('span', 'state ' + cls, text);
  tr.children[2].replaceChildren(s);
  return s;
};
$('btnFiles').onclick = async () => setPending(await api.pickFiles());
$('btnFolder').onclick = async () => setPending(await api.pickFolder());
const drop = $('drop');
document.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')));
document.addEventListener('dragleave', () => drop.classList.remove('over'));
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const paths = [...e.dataTransfer.files].map((f) => api.pathOf(f));
  setPending(await api.expand(paths));
  document.querySelector('[data-tab=files]').click();
});
$('btnRun').onclick = async () => {
  $('btnRun').disabled = true;
  $('fileInfo').textContent = 'Procesando…';
  const o = opts();
  const usable = {};
  for (const [f, rv] of Object.entries(reviews)) if (pending.includes(f) && rv.sig === sigOf(o)) usable[f] = rv.pages;
  o.reviews = usable;
  o.skips = {};
  for (const [f, s] of Object.entries(skips)) if (pending.includes(f) && s.sig === sigOf(o)) o.skips[f] = s.keys;
  const rows = [...document.querySelectorAll('#fileTable tbody tr')];
  const files = [...pending];
  $('progWrap').classList.remove('hidden');
  $('progBar').style.width = '0%';
  let done = 0;
  let total = 0;
  let last;
  for (const f of files) {
    const tr = rows.find((t) => t.dataset.f === f);
    if (tr) setState(tr, 'run', 'Procesando…');
    $('fileInfo').textContent = `Procesando ${done + 1} de ${files.length}…`;
    const r = await api.runFiles([f], o);
    last = r.session;
    const x = r.results[0];
    done++;
    $('progBar').style.width = Math.round((done / files.length) * 100) + '%';
    if (!tr) continue;
    if (x.error) {
      tr.children[1].textContent = '—';
      setState(tr, 'bad', 'Error').title = x.error;
      tr.children[2].append(mk('span', 'sub w', x.error));
      continue;
    }
    total += x.total || 0;
    const cs = mk('div', 'counts');
    for (const [k, v] of Object.entries(x.counts || {})) {
      const c = tint(mk('span', 'chip'), k);
      c.append(mk('b', null, v), k);
      cs.append(c);
    }
    tr.children[1].replaceChildren(x.total ? cs : mk('span', 'muted', 'Nada que tapar'));
    const warn = [
      ...(x.hidden && x.hidden.length ? [`${x.hidden.length} texto(s) oculto(s) en el PDF: «${x.hidden[0].text.slice(0, 50)}»`] : []),
      ...(x.warn || []),
      ...(x.residues && x.residues.length ? ['Posibles restos en: ' + x.residues.join(', ')] : [])
    ];
    const a = document.createElement('a');
    a.textContent = 'Ver copia';
    a.onclick = () => api.reveal(x.dest);
    const td = tr.children[2];
    td.replaceChildren(mk('span', 'state ' + (warn.length ? 'warn' : 'ok'), warn.length ? '⚠ Revisar' : '✓ Hecho'), ' ', a);
    warn.slice(0, 3).forEach((w) => td.append(mk('span', 'sub w', w)));
  }
  if (last) renderSession(last);
  $('fileInfo').textContent = `Listo: ${total} datos tapados en ${files.length} archivo${files.length > 1 ? 's' : ''}. Originales intactos.`;
  toast('Lote terminado ✓');
};

$('btnRestoreFiles').onclick = async () => {
  const r = await api.restoreFiles();
  if (r.canceled) return;
  $('fileInfo').replaceChildren(
    ...r.results.flatMap((x) => {
      const a = document.createElement('a');
      a.textContent = x.error ? `Error: ${x.error}` : `${x.restored} datos restaurados`;
      if (!x.error) a.onclick = () => api.reveal(x.dest);
      return [a, document.createTextNode('  ')];
    })
  );
};
$('btnAudit').onclick = async () => {
  const r = await api.auditExport();
  if (!r.canceled) $('fileInfo').textContent = r.error || 'Informe guardado: ' + r.path;
};
$('profile').onchange = async () => applyConfig(await api.profileConfig($('profile').value));

// ---- Ajustes
$('btnReveal').onclick = () => {
  revealed = !revealed;
  $('btnReveal').textContent = revealed ? 'Ocultar valores' : 'Mostrar valores';
  renderSession(lastSession);
};
$('btnReset').onclick = async () => {
  if (confirm('¿Empezar sesión nueva? Los marcadores actuales ya no se podrán restaurar si no la has guardado.')) renderSession(await api.sessionReset());
};
$('btnSave').onclick = async () => {
  const r = await api.sessionSave($('pwd').value, { custom: $('customTerms').value, enabled: opts().enabled });
  $('cfgMsg').textContent = r.error || (r.ok ? 'Expediente guardado cifrado: ' + r.path : '');
};
$('btnLoad').onclick = async () => {
  const r = await api.sessionLoad($('pwd').value);
  if (r.ok) {
    renderSession(r.session);
    if (r.config.custom != null) $('customTerms').value = r.config.custom;
    document.querySelectorAll('#typeList input').forEach((c) => r.config.enabled && c.dataset.t in r.config.enabled && (c.checked = r.config.enabled[c.dataset.t]));
  }
  $('cfgMsg').textContent = r.error || (r.ok ? 'Expediente cargado' : '');
};

async function nerRefresh(st) {
  st = st || (await api.nerStatus());
  $('chkNer').disabled = !st.installed;
  if (!st.installed) $('chkNer').checked = false;
  $('btnNer').classList.toggle('hidden', st.installed);
  $('btnNerDel').classList.toggle('hidden', !st.installed);
}
api.onNerProgress((p) => ($('nerMsg').textContent = 'Descargando modelo… ' + p + ' %'));
$('btnNer').onclick = async () => {
  $('btnNer').disabled = true;
  $('nerMsg').textContent = 'Descargando modelo… (única conexión de la app: solo huggingface.co)';
  const r = await api.nerDownload();
  $('btnNer').disabled = false;
  $('nerMsg').textContent = r.error ? 'Error: ' + r.error : 'Modelo instalado.';
  if (r.installed) $('chkNer').checked = true;
  nerRefresh();
};
$('btnNerDel').onclick = async () => {
  await api.nerRemove();
  $('nerMsg').textContent = 'Modelo borrado.';
  nerRefresh();
};

(async function init() {
  nerRefresh();
  const pr = await api.profiles();
  $('profile').replaceChildren(...pr.list.map((p) => Object.assign(document.createElement('option'), { value: p.id, textContent: p.label })));
  const types = pr.types;
  [...new Set(types.map((t) => t.type))].forEach((t, i) => (hues[t] = Math.round((150 + i * 137.5) % 360)));
  $('typeList').replaceChildren(
    ...types.map((t) => {
      const l = document.createElement('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.dataset.t = t.type;
      c.checked = t.defaultOn;
      l.append(c, document.createTextNode(t.label));
      return l;
    })
  );
  renderSession(await api.sessionGet());
})();
