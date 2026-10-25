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
  c.append('Pendiente');
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
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = it.type;
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
$('btnPasteIn').onclick = async () => ($('inText').value = await api.paste());
$('btnDetect').onclick = async () => {
  const r = await api.detect($('inText').value, opts());
  if (r.error) return ($('detInfo').textContent = r.error);
  matches = r.matches;
  included = new Set(matches.map((m) => m.id));
  $('detList').replaceChildren(
    ...matches.map((m) => {
      const d = document.createElement('div');
      d.className = 'det';
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = true;
      c.onchange = () => (c.checked ? included.add(m.id) : included.delete(m.id));
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = m.type;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = m.value;
      d.append(c, t, v);
      return d;
    })
  );
  $('detInfo').textContent = matches.length ? `${matches.length} datos detectados` : 'No se detectó nada';
  if (matches.length) $('btnApply').click();
};
$('btnApply').onclick = async () => {
  const sel = matches.filter((m) => included.has(m.id));
  const r = await api.apply($('inText').value, sel);
  $('outText').value = (sel.length && $('chkInstr').checked && $('mode').value !== 'irreversible' ? instr() : '') + r.text;
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
$('btnCopyOut').onclick = () => api.copy($('outText').value);

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
$('btnCopyRest').onclick = () => api.copy($('restText').value);

// ---- Archivos
function setPending(files) {
  pending = [...new Set(files)];
  $('fileTable').querySelector('tbody').replaceChildren(
    ...pending.map((f) => {
      const tr = document.createElement('tr');
      tr.dataset.f = f;
      const a = document.createElement('td');
      a.textContent = f;
      const b = document.createElement('td');
      const c = pendingCell(f);
      tr.append(a, b, c);
      return tr;
    })
  );
  $('btnRun').disabled = !pending.length;
  $('fileInfo').textContent = `${pending.length} archivos`;
}
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
  const r = await api.runFiles(pending, o);
  for (const x of r.results) {
    const tr = [...document.querySelectorAll('#fileTable tbody tr')].find((t) => t.dataset.f === x.file);
    if (!tr) continue;
    tr.children[1].textContent = x.error ? '—' : `${x.total} (${Object.entries(x.counts).map(([k, v]) => k + ' ' + v).join(', ')})`;
    const hid = x.hidden && x.hidden.length ? ` ⚠ ${x.hidden.length} texto(s) oculto(s) en el PDF: «${x.hidden[0].text.slice(0, 50)}»` : '';
    if (x.error) tr.children[2].textContent = 'Error: ' + x.error;
    else {
      const a = document.createElement('a');
      a.textContent = 'Ver copia';
      a.onclick = () => api.reveal(x.dest);
      const warn = [...(x.warn || []), ...(x.residues && x.residues.length ? ['Posibles restos en: ' + x.residues.join(', ')] : [])];
      tr.children[2].replaceChildren('✓ ', a, hid, warn.length ? ' ⚠ ' + warn.slice(0, 3).join(' · ') : '');
    }
  }
  renderSession(r.session);
  $('fileInfo').textContent = 'Listo. Originales intactos.';
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
