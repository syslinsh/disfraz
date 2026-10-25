'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Session, detect, apply, restore, leakCheckValues, summarize } = require('../core/anonymizer');
const { TYPES } = require('../core/detectors');
const { listDetections, scanPdfHidden, processFile, restoreFile, listFolder, isSupported, SUPPORTED } = require('../core/files');
const { closeOcr, analyzePdf } = require('../core/redact');
const ner = require('../core/ner');
const { AuditLog } = require('../core/audit');
const profiles = require('../core/profiles');
const vault = require('../core/vault');

let win;
let session = new Session();
const audit = new AuditLog();

// La sesión se recuerda entre aperturas: se guarda cifrada con el almacén del sistema (en Windows, DPAPI: solo tu usuario puede leerla).
const sessionFile = () => path.join(app.getPath('userData'), 'sesion.dat');
function persistSession() {
  try {
    if (session.mode === 'irreversible' || !session.size) return fs.rmSync(sessionFile(), { force: true });
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(sessionFile(), safeStorage.encryptString(JSON.stringify(session.toJSON())));
  } catch {
    /* sin persistencia: la sesión sigue funcionando en memoria */
  }
}
function loadPersistedSession() {
  try {
    if (!fs.existsSync(sessionFile()) || !safeStorage.isEncryptionAvailable()) return;
    session = new Session(JSON.parse(safeStorage.decryptString(fs.readFileSync(sessionFile()))));
  } catch {
    /* archivo ilegible: se empieza de cero */
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Disfraz',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const sessionInfo = () => ({
  mode: session.mode,
  size: session.size,
  items: session.items.map((i) => ({ placeholder: i.placeholder, type: i.type, value: i.value }))
});

ipcMain.handle('types', () => TYPES);

// el renderer solo puede pedir archivos que el usuario eligió (diálogos o arrastrar) o que la app generó
const allowed = new Set();
const allow = (list) => (list.forEach((p) => allowed.add(path.resolve(p))), list);
const isAllowed = (p) => typeof p === 'string' && allowed.has(path.resolve(p));

// el modelo de nombres vive en la carpeta de datos del usuario; la pantalla solo dice si quiere usarlo (opts.ner)
const nerDir = () => path.join(app.getPath('userData'), 'modelo-nombres');
const withNer = (o) => ({ ...o, nerDir: o && o.ner && ner.installed(nerDir()) ? nerDir() : undefined });

ipcMain.handle('detect', async (_e, text, opts) => {
  const o = withNer(opts);
  const matches = detect(text, o);
  try {
    if (o.nerDir) matches.push(...(await ner.nerMatches(text, o.nerDir, matches)));
  } catch (err) {
    return { error: err.message };
  }
  matches.sort((a, b) => a.start - b.start).forEach((m, i) => (m.id = i));
  return { matches, counts: summarize(matches) };
});

ipcMain.handle('ner:status', () => ({ installed: ner.installed(nerDir()), mb: Math.round(ner.MODEL_BYTES / 1e6) }));
let nerBusy = false;
ipcMain.handle('ner:download', async () => {
  if (nerBusy) return { error: 'Ya se está descargando' };
  nerBusy = true;
  try {
    await ner.download(nerDir(), (done, total) => win && win.webContents.send('ner:progress', Math.min(99, Math.round((done / total) * 100))));
    return { installed: ner.installed(nerDir()) };
  } catch (err) {
    return { error: err.message };
  } finally {
    nerBusy = false;
  }
});
ipcMain.handle('ner:remove', () => {
  fs.rmSync(nerDir(), { recursive: true, force: true });
  return { installed: false };
});

ipcMain.handle('mode:set', (_e, mode) => {
  if (['marcadores', 'realista', 'irreversible'].includes(mode)) session.mode = mode;
  persistSession();
  return sessionInfo();
});

ipcMain.handle('apply', (_e, text, matches) => {
  const out = apply(text, matches, session);
  audit.addText(text, matches, session.mode);
  persistSession();
  return { text: out, leaks: leakCheckValues(out, matches), session: sessionInfo() };
});

ipcMain.handle('restore', (_e, text) => restore(text, session));

ipcMain.handle('session:get', () => sessionInfo());
ipcMain.handle('session:reset', () => {
  session = new Session({ mode: session.mode });
  persistSession();
  return sessionInfo();
});

ipcMain.handle('session:save', async (_e, password, config) => {
  if (session.mode === 'irreversible') return { error: 'En modo irreversible no se guarda nada (no hay nada que restaurar)' };
  if (!password) return { error: 'Escribe una contraseña' };
  const r = await dialog.showSaveDialog(win, {
    defaultPath: 'expediente.anoni',
    filters: [{ name: 'Expediente Disfraz', extensions: ['anoni'] }]
  });
  if (r.canceled) return { canceled: true };
  fs.writeFileSync(r.filePath, vault.encrypt({ ...session.toJSON(), config: config || {} }, password));
  return { ok: true, path: r.filePath };
});

ipcMain.handle('session:load', async (_e, password) => {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'Sesión Disfraz', extensions: ['anoni'] }],
    properties: ['openFile']
  });
  if (r.canceled) return { canceled: true };
  try {
    const data = vault.decrypt(fs.readFileSync(r.filePaths[0], 'utf8'), password);
    session = new Session(data);
    persistSession();
    return { ok: true, session: sessionInfo(), config: data.config || {} };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('pick:files', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Documentos', extensions: SUPPORTED.map((s) => s.slice(1)) }]
  });
  return r.canceled ? [] : allow(r.filePaths);
});

ipcMain.handle('pick:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? [] : allow(listFolder(r.filePaths[0]));
});

ipcMain.handle('expand', (_e, paths) =>
  allow(Array.isArray(paths) ? paths : []).flatMap((p) => {
    try {
      return fs.statSync(p).isDirectory() ? listFolder(p) : isSupported(p) ? [p] : [];
    } catch {
      return [];
    }
  })
);

ipcMain.handle('files:run', async (_e, files, opts) => {
  const results = [];
  for (const f of files) {
    if (!isAllowed(f)) {
      results.push({ file: f, error: 'Ruta no permitida' });
      continue;
    }
    try {
      const r = await processFile(f, session, withNer(opts), null);
      audit.addFile(r, session.mode);
      if (r.dest) allow([r.dest]);
      results.push(r);
    } catch (err) {
      audit.addFile({ file: f, error: err.message });
      results.push({ file: f, error: err.message });
    }
  }
  persistSession();
  return { results, session: sessionInfo() };
});

ipcMain.handle('profiles', () => ({ list: profiles.list(), types: TYPES }));
ipcMain.handle('profile:config', (_e, id) => profiles.profileConfig(id, TYPES));

ipcMain.handle('files:restore', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Archivos devueltos por la IA', extensions: ['txt', 'md', 'csv', 'json', 'docx', 'xlsx'] }]
  });
  if (r.canceled) return { canceled: true };
  const results = [];
  for (const f of r.filePaths) {
    try {
      results.push(await restoreFile(f, session, null));
    } catch (err) {
      results.push({ file: f, error: err.message });
    }
  }
  return { results };
});

ipcMain.handle('audit:count', () => audit.entries.length);
ipcMain.handle('audit:export', async () => {
  if (!audit.entries.length) return { error: 'Todavía no hay nada anonimizado en esta sesión' };
  const r = await dialog.showSaveDialog(win, {
    defaultPath: 'informe-anonimizacion.md',
    filters: [{ name: 'Informe (Markdown)', extensions: ['md'] }]
  });
  if (r.canceled) return { canceled: true };
  fs.writeFileSync(r.filePath, audit.toMarkdown(), 'utf8');
  fs.writeFileSync(r.filePath.replace(/\.md$/i, '') + '.json', JSON.stringify(audit.toJSON(), null, 2), 'utf8');
  return { ok: true, path: r.filePath };
});

ipcMain.handle('pdf:analyze', async (_e, file, opts) => {
  if (!isAllowed(file)) return { error: 'Ruta no permitida' };
  try {
    return await analyzePdf(file, withNer({ ...opts, review: undefined, reviews: undefined }));
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('file:detections', async (_e, file, opts) => {
  if (!isAllowed(file)) return { error: 'Ruta no permitida' };
  try {
    return { items: await listDetections(file, withNer({ ...opts, skips: undefined })) };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('pdf:hidden', (_e, f) => (isAllowed(f) ? scanPdfHidden(f) : []));
ipcMain.handle('clipboard:write', (_e, t) => clipboard.writeText(t));
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('reveal', (_e, p) => isAllowed(p) && shell.showItemInFolder(p));

app.whenReady().then(() => {
  loadPersistedSession();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => closeOcr().catch(() => {}));
