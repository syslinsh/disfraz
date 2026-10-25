'use strict';
// Proceso hijo (modo Node): hace un trabajo de tachado y devuelve el resultado.
const { findNamesInline } = require('./ner');
const { analyzePdfInline, redactPdfInline, redactImageInline, closeOcr } = require('./redact');

process.on('message', async ({ job, args }) => {
  try {
    const [file, opts, dest, sessionData] = args;
    const result =
      job === 'ner'
        ? await findNamesInline(file, opts)
        : job === 'analyze'
        ? await analyzePdfInline(file, opts)
        : job === 'pdf'
          ? await redactPdfInline(file, opts, dest, null, sessionData)
          : await redactImageInline(file, opts, dest);
    await closeOcr().catch(() => {});
    process.send({ result }, () => process.exit(0));
  } catch (err) {
    await closeOcr().catch(() => {});
    process.send({ error: err && err.message ? err.message : String(err) }, () => process.exit(1));
  }
});
