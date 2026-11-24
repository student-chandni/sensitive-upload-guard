'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { normalizeText } = require('../inspect/marker');

// One dialog at a time, dedupes identical in-flight questions, and remembers recent
// answers (allow 30s, deny 3s) so the network layer doesn't ask again for something
// the user already answered in the page.

const ALLOW_TTL_MS = 30_000;
const DENY_TTL_MS = 3_000;

function promptKey(text) {
  return normalizeText(text).replace(/\s+/g, ' ').trim();
}

function sha(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

class DecisionService extends EventEmitter {
  constructor({ ask, getSettings }) {
    super();
    this.ask = ask;
    this.getSettings = getSettings;
    this.queue = Promise.resolve();
    this.inflight = new Map(); // key -> Promise<decision>
    this.recent = []; // { key, decision, expires }
  }

  _remember(key, decision) {
    const now = Date.now();
    this.recent = this.recent.filter((r) => r.expires > now && r.key !== key);
    this.recent.push({ key, decision, expires: now + (decision === 'allow' ? ALLOW_TTL_MS : DENY_TTL_MS) });
  }

  _recall(candidates) {
    const now = Date.now();
    this.recent = this.recent.filter((r) => r.expires > now);
    for (const r of this.recent) {
      if (!r.key.startsWith('prompt:')) continue;
      const approved = r.key.slice(7);
      for (const c of candidates) {
        const k = promptKey(c);
        if (!k) continue;
        // site may trim/rewrap the prompt
        if (k === approved || (approved.length >= 12 && k.includes(approved)) || (k.length >= 12 && approved.includes(k))) return r.decision;
      }
    }
    return null;
  }

  _serialized(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  _record(evt) {
    this.emit('event', { time: new Date().toISOString(), ...evt });
  }

  async decidePrompt({ site, text, layer, candidates }) {
    const settings = this.getSettings();
    // only the network layer reuses decisions, a real user action always gets a dialog
    const remembered = layer === 'network' ? this._recall(candidates && candidates.length ? candidates : [text]) : null;
    if (remembered) {
      this._record({ kind: 'prompt', site: site.name, layer, decision: remembered, via: 'remembered', length: text.length, hash: sha(text) });
      return remembered;
    }
    const key = `prompt:${promptKey(text)}`;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = this._serialized(async () => {
      // may have been decided while queued
      const late = layer === 'network' ? this._recall(candidates && candidates.length ? candidates : [text]) : null;
      if (late) return late;
      const answer = await this.ask({ kind: 'prompt', siteName: site.name, prompt: text, marker: settings.marker });
      const decision = answer === 'allow' ? 'allow' : 'deny';
      this._remember(key, decision);
      this._record({ kind: 'prompt', site: site.name, layer, decision, via: answer === 'timeout' ? 'timeout' : 'user', length: text.length, hash: sha(text) });
      return decision;
    });
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  async decideFiles({ site, source, results }) {
    const settings = this.getSettings();
    const needsAsk = results.filter((r) => r.status === 'sensitive' || (r.status === 'error' && settings.onInspectionError === 'ask'));
    const summary = results.map((r) => ({ name: r.name, status: r.status, kind: r.kind, size: r.size, location: r.location, error: r.error, sha256: r.sha256 }));
    if (!needsAsk.length) {
      this._record({ kind: 'file', site: site.name, source, decision: 'allow', via: 'clean', files: summary });
      return 'allow';
    }
    const key = `files:${results.map((r) => r.sha256).sort().join(',')}`;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this._serialized(async () => {
      const answer = await this.ask({ kind: 'file', siteName: site.name, source, files: results, marker: settings.marker });
      const decision = answer === 'allow' ? 'allow' : 'deny';
      this._record({ kind: 'file', site: site.name, source, decision, via: answer === 'timeout' ? 'timeout' : 'user', files: summary });
      return decision;
    });
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }
}

module.exports = { DecisionService, promptKey };
