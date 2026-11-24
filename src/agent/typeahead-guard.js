// Main world. Perplexity sends keystrokes to suggest.perplexity.ai over a websocket,
// which Fetch can't intercept, so drop frames that contain the marker.
(function sugTypeaheadGuard(CFG) {
  'use strict';
  if (!CFG.hosts.length || typeof WebSocket !== 'function') return;
  const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
  const norm = (s) => String(s).normalize('NFKC').replace(INVISIBLE, '').toUpperCase();
  const needle = norm(CFG.marker);
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function send(data) {
    try {
      const host = new URL(this.url).hostname;
      if (typeof data === 'string' && CFG.hosts.includes(host) && norm(data).includes(needle)) return undefined;
    } catch (e) {
      /* fall through */
    }
    return origSend.call(this, data);
  };
  // look native
  Object.defineProperty(WebSocket.prototype.send, 'toString', { value: () => 'function send() { [native code] }' });
})(__SUG_TYPEAHEAD__);
