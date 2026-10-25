'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  types: call('types'),
  detect: call('detect'),
  apply: call('apply'),
  restore: call('restore'),
  setMode: call('mode:set'),
  nerStatus: call('ner:status'),
  nerDownload: call('ner:download'),
  nerRemove: call('ner:remove'),
  onNerProgress: (cb) => ipcRenderer.on('ner:progress', (_e, p) => cb(p)),
  pdfAnalyze: call('pdf:analyze'),
  pdfHidden: call('pdf:hidden'),
  fileDetections: call('file:detections'),
  profiles: call('profiles'),
  profileConfig: call('profile:config'),
  restoreFiles: call('files:restore'),
  auditExport: call('audit:export'),
  sessionGet: call('session:get'),
  sessionReset: call('session:reset'),
  sessionSave: call('session:save'),
  sessionLoad: call('session:load'),
  pickFiles: call('pick:files'),
  pickFolder: call('pick:folder'),
  expand: call('expand'),
  runFiles: call('files:run'),
  copy: call('clipboard:write'),
  paste: call('clipboard:read'),
  reveal: call('reveal'),
  pathOf: (file) => webUtils.getPathForFile(file)
});
