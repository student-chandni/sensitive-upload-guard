'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { CdpConnection } = require('../cdp/connection');
const { launchBrowser, attachToBrowser } = require('../browser/launcher');
const { SITES, siteForUrl } = require('../sites');
const { TabGuard, agentSettings } = require('./tab-guard');

const AGENT_PATH = path.join(__dirname, '..', '..', 'agent', 'page-agent.js');
const TYPEAHEAD_PATH = path.join(__dirname, '..', '..', 'agent', 'typeahead-guard.js');

// Launches/attaches to Chrome and guards every page target.
// waitForDebuggerOnStart keeps new tabs paused until they're set up.
class Guard extends EventEmitter {
  constructor({ decisions, settings, profileDir, log }) {
    super();
    this.decisions = decisions;
    this.settings = settings;
    this.profileDir = profileDir;
    this.log = log;
    this.conn = null;
    this.browser = null;
    this.tabs = new Map(); // sessionId -> TabGuard
    this.targets = new Map(); // targetId -> url
    this.state = 'stopped';
    this.lastError = null;
    // random per run
    const nonce = crypto.randomBytes(6).toString('hex');
    this.bindingName = `__sug_${nonce}`;
    this.worldName = `sensitive-upload-guard-${nonce}`;
    settings.on('change', (_keys, all) => {
      for (const t of this.tabs.values()) t.pushSettings(all);
    });
  }

  _setState(state, error = null) {
    this.state = state;
    this.lastError = error;
    this.emit('status', this.status());
  }

  status() {
    const guardedTabs = [...this.targets.values()].filter((u) => siteForUrl(u)).length;
    return {
      state: this.state,
      error: this.lastError,
      product: this.browser?.product || null,
      executable: this.browser?.executable || null,
      tabs: this.targets.size,
      guardedTabs,
    };
  }

  _agentSource() {
    const config = {
      binding: this.bindingName,
      sites: SITES.map(({ id, name, hosts, composerSelectors, sendButtonSelectors, responseSelectors }) => ({ id, name, hosts, composerSelectors, sendButtonSelectors, responseSelectors })),
      settings: agentSettings(this.settings.all()),
      // a bit longer than the dialog timeout
      answerTimeoutMs: (this.settings.get('dialogTimeoutSec') || 600) * 1000 + 15000,
    };
    return fs.readFileSync(AGENT_PATH, 'utf8').replace('__SUG_CONFIG__', () => JSON.stringify(config));
  }

  _typeaheadSource() {
    const config = { hosts: SITES.flatMap((s) => s.typeaheadWebSocketHosts || []), marker: this.settings.get('marker') };
    return fs.readFileSync(TYPEAHEAD_PATH, 'utf8').replace('__SUG_TYPEAHEAD__', () => JSON.stringify(config));
  }

  async start({ attachPort } = {}) {
    if (this.state === 'running' || this.state === 'starting') return this.status();
    this._setState('starting');
    try {
      this.browser = attachPort
        ? await attachToBrowser(attachPort)
        : await launchBrowser({ profileDir: this.profileDir, executable: this.settings.get('browserPath'), startUrls: SITES.map((s) => s.startUrl) });
      this.conn = await CdpConnection.connect(this.browser.wsUrl);
      this.conn.on('close', () => this._onDisconnected());
      this.conn.on('Target.attachedToTarget', (p) => this._onAttached(p));
      this.conn.on('Target.detachedFromTarget', (p) => this._onDetached(p));
      this.conn.on('Target.targetInfoChanged', ({ targetInfo }) => this._trackTarget(targetInfo));
      this.conn.on('Target.targetCreated', ({ targetInfo }) => this._trackTarget(targetInfo));
      this.conn.on('Target.targetDestroyed', ({ targetId }) => {
        this.targets.delete(targetId);
        this.emit('status', this.status());
      });
      await this.conn.send('Target.setDiscoverTargets', { discover: true, filter: [{ type: 'page' }] });
      await this.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] });
      this.log('info', `connected to ${this.browser.product}`);
      this._setState('running');
    } catch (e) {
      this.log('error', `could not start browser: ${e.message}`);
      this._cleanup();
      this._setState('error', e.message);
    }
    return this.status();
  }

  _trackTarget(info) {
    if (info.type !== 'page') return;
    this.targets.set(info.targetId, info.url);
    this.emit('status', this.status());
  }

  async _onAttached({ sessionId, targetInfo, waitingForDebugger }) {
    if (targetInfo.type !== 'page') return;
    this._trackTarget(targetInfo);
    const tab = new TabGuard({
      conn: this.conn,
      sessionId,
      targetInfo,
      agentSource: this._agentSource(),
      typeaheadSource: this._typeaheadSource(),
      bindingName: this.bindingName,
      worldName: this.worldName,
      decisions: this.decisions,
      getSettings: () => this.settings.all(),
      log: this.log,
    });
    this.tabs.set(sessionId, tab);
    try {
      await tab.init();
    } catch (e) {
      this.log('warn', `could not guard tab ${targetInfo.url}: ${e.message}`);
    } finally {
      // always resume, even if setup failed
      if (waitingForDebugger) this.conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  }

  _onDetached({ sessionId }) {
    const tab = this.tabs.get(sessionId);
    if (tab) {
      tab.dispose();
      this.tabs.delete(sessionId);
    }
  }

  _onDisconnected() {
    const wasRunning = this.state === 'running';
    this._cleanup();
    if (wasRunning) this.log('info', 'browser closed');
    this._setState('stopped');
  }

  _cleanup() {
    for (const t of this.tabs.values()) t.dispose();
    this.tabs.clear();
    this.targets.clear();
    if (this.conn) {
      this.conn.removeAllListeners();
      this.conn.close();
    }
    this.conn = null;
  }

  async openUrl(url) {
    if (this.state !== 'running') await this.start();
    if (this.state !== 'running') return;
    const existing = [...this.targets.entries()].find(([, u]) => u.startsWith(url));
    if (existing) await this.conn.send('Target.activateTarget', { targetId: existing[0] }).catch(() => {});
    else await this.conn.send('Target.createTarget', { url }).catch((e) => this.log('warn', e.message));
  }

  async stop({ closeBrowser = true } = {}) {
    if (this.conn && closeBrowser && this.browser?.child) {
      await this.conn.send('Browser.close').catch(() => {});
    }
    this._cleanup();
    this._setState('stopped');
  }
}

module.exports = { Guard };
