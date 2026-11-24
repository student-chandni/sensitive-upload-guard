'use strict';

// some npm setups skip install scripts, so fetch the electron binary if it's missing
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let ok = false;
try {
  ok = fs.existsSync(require('electron'));
} catch {
  ok = false;
}
if (!ok) {
  console.log('[sensitive-upload-guard] Electron binary missing, downloading it…');
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', 'electron', 'install.js')], { stdio: 'inherit' });
  process.exit(res.status || 0);
}
