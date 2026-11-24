'use strict';

const { SITES, siteForSubmitUrl } = require('../sites');
const { findMarkerInBody } = require('../inspect/body-decoder');
const { inspectFile } = require('../inspect');

// Per-tab setup: agent injection, binding, Fetch backstop.
// Runtime.enable is needed, otherwise addBinding doesn't show up in the context.
class TabGuard {
  constructor({ conn, sessionId, targetInfo, agentSource, typeaheadSource, bindingName, worldName, decisions, getSettings, log }) {
    Object.assign(this, { conn, sessionId, targetInfo, agentSource, typeaheadSource, bindingName, worldName, decisions, getSettings, log });
    this.contexts = new Set(); // contexts whose agent said hello
    this.disposed = false;
    this._handlers = [
      [`${sessionId}:Runtime.bindingCalled`, (p) => this._onBinding(p)],
      [`${sessionId}:Fetch.requestPaused`, (p) => this._onRequestPaused(p)],
      [`${sessionId}:Runtime.executionContextDestroyed`, (p) => this.contexts.delete(p.executionContextId)],
      [`${sessionId}:Runtime.executionContextsCleared`, () => this.contexts.clear()],
    ];
    for (const [ev, fn] of this._handlers) conn.on(ev, fn);
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  async init() {
    // needed so the injected script also runs after cross-process navigations
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Runtime.addBinding', { name: this.bindingName, executionContextName: this.worldName });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: this.agentSource, worldName: this.worldName, runImmediately: true });
    // typeahead ws hook (perplexity only)
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: typeaheadWrapper(this.typeaheadSource), runImmediately: true });
    const patterns = SITES.flatMap((s) => s.submitEndpoints).map((urlPattern) => ({ urlPattern, requestStage: 'Request' }));
    await this.send('Fetch.enable', { patterns });
  }

  dispose() {
    this.disposed = true;
    for (const [ev, fn] of this._handlers) this.conn.off(ev, fn);
  }

  async _reply(contextId, id, decision) {
    try {
      await this.send('Runtime.evaluate', {
        contextId,
        expression: `globalThis.__sugResolve && globalThis.__sugResolve(${Number(id)}, ${JSON.stringify(decision)})`,
        returnByValue: true,
      });
    } catch {
      /* tab navigated away */
    }
  }

  pushSettings(settings) {
    const payload = JSON.stringify(agentSettings(settings));
    for (const contextId of this.contexts) {
      this.send('Runtime.evaluate', { contextId, expression: `globalThis.__sugUpdate && globalThis.__sugUpdate(${payload})` }).catch(() => this.contexts.delete(contextId));
    }
  }

  async _onBinding({ name, payload, executionContextId }) {
    if (name !== this.bindingName || this.disposed) return;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    const site = SITES.find((s) => s.id === msg.siteId);
    if (!site) return;

    if (msg.type === 'hello') {
      this.contexts.add(executionContextId);
      this.pushSettings(this.getSettings());
      this.log('debug', `agent active on ${site.name}: ${msg.url}`);
      return;
    }

    if (msg.type === 'prompt') {
      const decision = await this.decisions.decidePrompt({ site, text: String(msg.text || ''), layer: 'dom' }).catch((e) => {
        this.log('error', `prompt decision failed: ${e.message}`);
        return 'deny';
      });
      return this._reply(executionContextId, msg.id, decision);
    }

    if (msg.type === 'files') {
      const decision = await this._decideFiles(site, msg).catch((e) => {
        this.log('error', `file decision failed: ${e.message}`);
        return 'deny';
      });
      return this._reply(executionContextId, msg.id, decision);
    }
  }

  async _decideFiles(site, msg) {
    const settings = this.getSettings();
    const files = Array.isArray(msg.files) ? msg.files : [];
    const results = [];
    for (const f of files) {
      const meta = { name: String(f.name || 'file'), size: Number(f.size) || 0, mimeType: String(f.type || '') };
      if (f.data == null) {
        const error = f.readError ? `could not read file (${f.readError})` : `larger than the ${Math.round(settings.maxInspectBytes / 1048576)} MB inspection limit`;
        results.push({ ...meta, kind: 'unknown', status: 'error', error, sha256: `${meta.name}:${meta.size}` });
        continue;
      }
      const buffer = Buffer.from(f.data, 'base64');
      const verdict = await inspectFile({ buffer, name: meta.name, mimeType: meta.mimeType }, settings);
      this.log('info', `inspected ${meta.name} (${verdict.kind}, ${verdict.ms} ms): ${verdict.status}${verdict.location ? ` in ${verdict.location}` : ''}${verdict.error ? ` – ${verdict.error}` : ''}`);
      results.push({ ...meta, ...verdict });
    }
    return this.decisions.decideFiles({ site, source: msg.source, results });
  }

  async _onRequestPaused(params) {
    const { requestId, request } = params;
    let action = 'continue';
    try {
      const settings = this.getSettings();
      const method = (request.method || 'GET').toUpperCase();
      const site = siteForSubmitUrl(request.url);
      const ignored = site && site.ignoreEndpointRegex && site.ignoreEndpointRegex.test(new URL(request.url).pathname);
      if (site && settings.inspectPrompts && !ignored && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const hit = findMarkerInBody(request, settings.marker);
        if (hit.found) {
          const decision = await this.decisions.decidePrompt({ site, text: hit.text, layer: 'network', candidates: hit.strings });
          action = decision === 'allow' ? 'continue' : 'block';
          this.log(decision === 'allow' ? 'info' : 'warn', `network backstop ${decision === 'allow' ? 'allowed' : 'blocked'} ${method} ${new URL(request.url).pathname}`);
        }
      }
    } catch (e) {
      // fail closed - a blocked request can be retried, a leaked one can't
      this.log('error', `backstop error, blocking request: ${e.message}`);
      action = 'block';
    } finally {
      const p = action === 'continue' ? this.send('Fetch.continueRequest', { requestId }) : this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      p.catch(() => {});
    }
  }
}

function typeaheadWrapper(source) {
  const hosts = SITES.filter((s) => (s.typeaheadWebSocketHosts || []).length).flatMap((s) => s.hosts);
  return `if (${JSON.stringify(hosts)}.some((h) => location.hostname === h || location.hostname.endsWith('.' + h))) {\n${source}\n}`;
}

function agentSettings(s) {
  return {
    marker: s.marker,
    responseColor: s.responseColor,
    inspectPrompts: s.inspectPrompts,
    inspectFiles: s.inspectFiles,
    maxInspectBytes: s.maxInspectBytes,
  };
}

module.exports = { TabGuard, agentSettings };
