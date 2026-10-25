'use strict';
const path = require('path');

/**
 * En el proceso main de Electron, @napi-rs/canvas se cierra de golpe al renderizar (buffers externos no permitidos).
 * Por eso allí el trabajo se hace en un proceso hijo en modo Node (ELECTRON_RUN_AS_NODE), que además aísla cualquier fallo nativo.
 */
const inElectronMain = () => !!process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE;

function runInChild(job, args, timeoutMs) {
  const { fork } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'redact-worker.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execPath: process.execPath,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
    let done = false;
    const timer = timeoutMs && setTimeout(() => !done && ((done = true), child.kill(), reject(new Error('Tardó demasiado (más de ' + Math.round(timeoutMs / 1000) + ' s)'))), timeoutMs);
    child.on('message', (m) => {
      done = true;
      clearTimeout(timer);
      m.error ? reject(new Error(m.error)) : resolve(m.result);
    });
    child.on('error', (e) => !done && ((done = true), reject(e)));
    child.on('exit', (code) => !done && ((done = true), clearTimeout(timer), reject(new Error('El motor de tachado se cerró inesperadamente (código ' + code + ')'))));
    child.send({ job, args });
  });
}


module.exports = { inElectronMain, runInChild };
