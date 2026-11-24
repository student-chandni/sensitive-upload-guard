'use strict';

const path = require('path');
const os = require('os');

// one shared worker, bundled eng model so it works offline

let workerPromise = null;
let queue = Promise.resolve();

function langPath() {
  const pkgDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  return path.join(pkgDir, '4.0.0_best_int');
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, OEM, PSM } = require('tesseract.js');
      const worker = await createWorker('eng', OEM.LSTM_ONLY, {
        langPath: langPath(),
        gzip: true,
        cachePath: path.join(os.tmpdir(), 'sensitive-upload-guard-tessdata'),
        logger: () => {},
        errorHandler: () => {},
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function recognize(imageBuffer) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(imageBuffer);
    return data.text || '';
  });
  queue = job.catch(() => {});
  return job;
}

async function warmUp() {
  try {
    await getWorker();
  } catch {
    /* reported when actually used */
  }
}

async function shutdown() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    /* ignore */
  }
  workerPromise = null;
}

module.exports = { recognize, warmUp, shutdown };
