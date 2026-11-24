'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

// Minimal CDP client (flattened sessions).
// Emits '<method>' for browser events and '<sessionId>:<method>' for tab events.
class CdpConnection extends EventEmitter {
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return new CdpConnection(ws);
  }

  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
      this.emit('close');
    });
    ws.on('error', (err) => this.emit('error', err));
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(`${p.method}: ${msg.error.message}`);
        err.code = msg.error.code;
        p.reject(err);
      } else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      this.emit('event', msg.method, msg.params || {}, msg.sessionId);
      this.emit(msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method, msg.params || {});
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { CdpConnection };
