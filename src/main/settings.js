'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = Object.freeze({
  marker: 'WALLED_SENSITIVE',
  responseColor: '#0f9d58',
  inspectPrompts: true,
  inspectFiles: true,
  ocrEnabled: true,
  maxOcrPages: 10,
  maxInspectBytes: 50 * 1024 * 1024,
  // 'ask' | 'allow' when a file can't be inspected
  onInspectionError: 'ask',
  // 0 = no timeout
  dialogTimeoutSec: 120,
  // empty = auto-detect
  browserPath: '',
  closeBrowserOnQuit: true,
});

class Settings extends EventEmitter {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'settings.json');
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const k of Object.keys(DEFAULTS)) if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) this.values[k] = saved[k];
    } catch {
      /* first run */
    }
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  update(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS) || typeof v !== typeof DEFAULTS[k]) continue;
      if (k === 'responseColor' && !/^#[0-9a-f]{6}$/i.test(v)) continue;
      if (k === 'marker' && !String(v).trim()) continue;
      if (this.values[k] !== v) {
        this.values[k] = v;
        changed.push(k);
      }
    }
    if (changed.length) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
      this.emit('change', changed, this.all());
    }
    return this.all();
  }
}

module.exports = { Settings, DEFAULTS };
