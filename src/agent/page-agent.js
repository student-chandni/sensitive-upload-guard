// Runs in an isolated world, injected by the app over CDP (see tab-guard.js).
// The config placeholder at the bottom is filled in by guard.js.
(function sensitiveUploadGuardAgent(CONFIG) {
  'use strict';
  if (globalThis.__sugAgentInstalled) return;
  globalThis.__sugAgentInstalled = true;

  const host = location.hostname;
  const site = CONFIG.sites.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h)));
  if (!site) return;

  let cfg = CONFIG.settings;
  let seq = 0;
  const pending = new Map();
  let bypass = false; // set while replaying an approved action

  // bridge to the app
  function emit(msg) {
    const fn = globalThis[CONFIG.binding];
    if (typeof fn !== 'function') return false;
    fn(JSON.stringify({ ...msg, siteId: site.id, url: location.href }));
    return true;
  }

  function ask(msg) {
    const id = ++seq;
    return new Promise((resolve) => {
      // no answer from the app -> deny
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve('deny');
      }, CONFIG.answerTimeoutMs);
      pending.set(id, (decision) => {
        clearTimeout(timer);
        resolve(decision);
      });
      if (!emit({ ...msg, id })) {
        clearTimeout(timer);
        pending.delete(id);
        resolve('deny');
      }
    });
  }

  // called by the app via Runtime.evaluate
  globalThis.__sugResolve = (id, decision) => {
    const fn = pending.get(id);
    pending.delete(id);
    if (fn) fn(decision === 'allow' ? 'allow' : 'deny');
  };
  globalThis.__sugUpdate = (settings) => {
    cfg = { ...cfg, ...settings };
    applyResponseColor();
  };

  // binding can show up late in tabs that were already open, so retry
  (function hello(attempt) {
    if (!emit({ type: 'hello' }) && attempt < 150) setTimeout(() => hello(attempt + 1), 200);
  })(0);

  // marker check (same logic as marker.js)
  const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
  const norm = (s) => String(s || '').normalize('NFKC').replace(INVISIBLE, '').toUpperCase();
  const hasMarker = (s) => norm(s).includes(norm(cfg.marker));

  // dom helpers
  const EDITABLE_SEL = 'textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  function realTarget(e) {
    const p = e.composedPath && e.composedPath();
    return (p && p[0]) || e.target;
  }

  function editableRoot(el) {
    if (!(el instanceof Element)) return null;
    if (el.matches('textarea, input')) return el.matches(EDITABLE_SEL) ? el : null;
    if (!el.isContentEditable) return null;
    let root = el;
    while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
    return root;
  }

  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

  function readText(el) {
    if (!el) return '';
    if ('value' in el && el.matches('textarea, input')) return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function queryVisible(selectors, root = document) {
    for (const sel of selectors) {
      try {
        for (const el of root.querySelectorAll(sel)) if (visible(el)) return el;
      } catch {
        /* bad selector in config */
      }
    }
    return null;
  }

  function findComposer(near) {
    const active = editableRoot(document.activeElement);
    if (near) {
      let node = near;
      for (let i = 0; i < 10 && node; i++, node = node.parentElement) {
        const sel = site.composerSelectors.concat(EDITABLE_SEL);
        const found = queryVisible(sel, node);
        if (found) return editableRoot(found) || found;
      }
    }
    return active || queryVisible(site.composerSelectors);
  }

  const NOT_SEND = /stop|cancel|dictat|voice|micro|record|attach|upload|file|model|add |plus|search mode|tool|menu|more/i;
  function isSendButton(btn) {
    if (!btn || btn.disabled) return false;
    if (site.sendButtonSelectors.some((s) => { try { return btn.matches(s); } catch { return false; } })) return true;
    const label = [btn.getAttribute('aria-label'), btn.getAttribute('title'), btn.getAttribute('data-testid'), btn.id].filter(Boolean).join(' ');
    if (label && NOT_SEND.test(label)) return false;
    if (/\b(send|submit)\b/i.test(label)) return true;
    return btn.type === 'submit' && !!btn.form && !!btn.form.querySelector(EDITABLE_SEL);
  }

  function findSendButton(editor) {
    const direct = queryVisible(site.sendButtonSelectors);
    if (direct && !direct.disabled) return direct;
    let node = editor;
    for (let i = 0; i < 10 && node; i++, node = node.parentElement) {
      for (const b of node.querySelectorAll('button, [role="button"], input[type="submit"]')) if (isSendButton(b)) return b;
    }
    return null;
  }

  // toast
  let toastHost = null;
  let toastBox = null;
  let toastTimer = null;
  function toast(text, tone = 'info', ms = 2600) {
    try {
      if (!toastHost || !toastHost.isConnected) {
        toastHost = document.createElement('sug-toast');
        const shadow = toastHost.attachShadow({ mode: 'closed' });
        toastBox = document.createElement('div');
        shadow.appendChild(toastBox);
        Object.assign(toastHost.style, { position: 'fixed', zIndex: '2147483647', right: '16px', bottom: '16px', pointerEvents: 'none' });
        Object.assign(toastBox.style, {
          font: '500 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          padding: '9px 13px', borderRadius: '10px', boxShadow: '0 6px 24px rgba(0,0,0,.25)', color: '#fff', maxWidth: '360px',
          transition: 'opacity .2s', opacity: '0',
        });
        document.documentElement.appendChild(toastHost);
      }
      toastBox.textContent = 'Sensitive Upload Guard: ' + text;
      toastBox.style.background = tone === 'block' ? '#b42318' : tone === 'ok' ? '#067647' : '#344054';
      toastBox.style.opacity = '1';
      clearTimeout(toastTimer);
      if (ms) toastTimer = setTimeout(() => (toastBox.style.opacity = '0'), ms);
    } catch {
      /* cosmetic only */
    }
  }
  const hideToast = () => toastBox && (toastBox.style.opacity = '0');

  // prompts
  let promptInFlight = false;

  async function guardPrompt(ctx) {
    if (promptInFlight) return; // ignore extra Enters while the dialog is up
    promptInFlight = true;
    try {
      const decision = await ask({ type: 'prompt', text: ctx.text, trigger: ctx.trigger });
      if (decision === 'allow') {
        replaySubmit(ctx);
      } else {
        toast('prompt blocked. Edit it and send again when ready.', 'block');
        try { ctx.editor && ctx.editor.focus(); } catch { /* ignore */ }
      }
    } finally {
      promptInFlight = false;
    }
  }

  function replaySubmit(ctx) {
    bypass = true;
    try {
      if (ctx.trigger === 'submit' && ctx.form && ctx.form.isConnected) {
        ctx.form.requestSubmit(ctx.submitter && ctx.submitter.isConnected ? ctx.submitter : undefined);
        return;
      }
      const btn = ctx.button && ctx.button.isConnected && !ctx.button.disabled ? ctx.button : findSendButton(ctx.editor);
      if (btn) {
        btn.click();
        return;
      }
      const target = ctx.target && ctx.target.isConnected ? ctx.target : ctx.editor;
      if (target) {
        target.focus();
        const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keypress', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
      }
    } finally {
      bypass = false;
    }
  }

  function block(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  window.addEventListener('keydown', (e) => {
    if (bypass || !cfg.inspectPrompts) return;
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    const target = realTarget(e);
    const editor = editableRoot(target);
    if (!editor) return;
    if (promptInFlight) return block(e);
    const text = readText(editor);
    if (!hasMarker(text)) return;
    block(e);
    guardPrompt({ trigger: 'enter', text, editor, target });
  }, true);

  const onClickLike = (e) => {
    if (bypass || !cfg.inspectPrompts) return;
    const t = realTarget(e);
    const btn = t instanceof Element ? t.closest('button, [role="button"], input[type="submit"]') : null;
    if (!btn || !isSendButton(btn)) return;
    const editor = findComposer(btn);
    const text = readText(editor);
    if (promptInFlight && hasMarker(text)) return block(e);
    if (!hasMarker(text)) return;
    block(e);
    if (e.type === 'click') guardPrompt({ trigger: 'click', text, editor, button: btn });
  };
  window.addEventListener('click', onClickLike, true);
  // some UIs send on pointerup/mouseup - swallow those so click is the only path
  window.addEventListener('pointerup', onClickLike, true);
  window.addEventListener('mouseup', onClickLike, true);

  window.addEventListener('submit', (e) => {
    if (bypass || !cfg.inspectPrompts) return;
    const form = realTarget(e);
    if (!(form instanceof HTMLFormElement)) return;
    const editor = [...form.querySelectorAll(EDITABLE_SEL)].map(editableRoot).find((el) => el && hasMarker(readText(el)));
    if (!editor) return;
    block(e);
    guardPrompt({ trigger: 'submit', text: readText(editor), editor, form, submitter: e.submitter });
  }, true);

  // files
  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  async function inspectFiles(files, source) {
    const slow = setTimeout(() => toast(`scanning ${files.length === 1 ? `"${files[0].name}"` : `${files.length} files`}…`, 'info', 0), 250);
    try {
      const payload = [];
      for (const f of files) {
        let data = null;
        let readError = null;
        if (f.size <= cfg.maxInspectBytes) {
          try { data = await readAsBase64(f); } catch (err) { readError = String(err && err.message || err); }
        }
        payload.push({ name: f.name || 'pasted-file', type: f.type, size: f.size, data, readError });
      }
      const decision = await ask({ type: 'files', source, files: payload });
      clearTimeout(slow);
      hideToast();
      if (decision !== 'allow') toast('upload blocked.', 'block');
      return decision;
    } catch {
      clearTimeout(slow);
      toast('upload blocked (inspection failed).', 'block');
      return 'deny';
    }
  }

  const copyFiles = (files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  };
  const sig = (files) => files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|');

  // file input: hold input+change, refire on continue, clear the input on cancel
  const fileJobs = new WeakMap();
  function onFileInput(e) {
    if (!cfg.inspectFiles) return;
    const el = realTarget(e);
    if (!(el instanceof HTMLInputElement) || el.type !== 'file') return;
    if (el.__sugBypass) return;
    const files = el.files ? [...el.files] : [];
    if (!files.length) return;
    e.stopImmediatePropagation();
    const s = sig(files);
    let job = fileJobs.get(el);
    if (!job || job.sig !== s) {
      job = { sig: s, events: [] };
      fileJobs.set(el, job);
      job.promise = inspectFiles(files, 'file picker').then((decision) => {
        if (fileJobs.get(el) === job) fileJobs.delete(el);
        if (decision === 'allow') {
          el.__sugBypass = true;
          try {
            for (const type of ['input', 'change']) if (job.events.includes(type)) el.dispatchEvent(new Event(type, { bubbles: true }));
          } finally {
            el.__sugBypass = false;
          }
        } else {
          el.value = '';
        }
      });
    }
    if (!job.events.includes(e.type)) job.events.push(e.type);
  }
  window.addEventListener('input', onFileInput, true);
  window.addEventListener('change', onFileInput, true);

  // the DataTransfer is unreadable after the handler returns, so copy the files
  let dropBypass = false;
  window.addEventListener('drop', (e) => {
    if (dropBypass || !cfg.inspectFiles) return;
    const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
    if (!files.length) return;
    block(e);
    const target = realTarget(e);
    const copy = copyFiles(files);
    const init = { bubbles: true, cancelable: true, composed: true, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY };
    inspectFiles(files, 'drag and drop').then((decision) => {
      dropBypass = true;
      try {
        if (decision === 'allow') target.dispatchEvent(new DragEvent('drop', { ...init, dataTransfer: copy }));
        // close the site's drop overlay
        else target.dispatchEvent(new DragEvent('dragleave', { ...init, dataTransfer: new DataTransfer() }));
      } finally {
        dropBypass = false;
      }
    });
  }, true);

  // only pastes with files, text gets checked on submit
  let pasteBypass = false;
  window.addEventListener('paste', (e) => {
    if (pasteBypass || !cfg.inspectFiles) return;
    const cd = e.clipboardData;
    const files = cd && cd.files ? [...cd.files] : [];
    if (!files.length) return;
    block(e);
    const target = realTarget(e);
    const copy = copyFiles(files);
    for (const type of ['text/plain', 'text/html']) {
      try { const v = cd.getData(type); if (v) copy.setData(type, v); } catch { /* ignore */ }
    }
    inspectFiles(files, 'paste').then((decision) => {
      if (decision !== 'allow') return;
      pasteBypass = true;
      try {
        target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: copy, bubbles: true, cancelable: true, composed: true }));
      } finally {
        pasteBypass = false;
      }
    });
  }, true);

  // response colour. adoptedStyleSheets isn't blocked by CSP like a <style> would be
  const sheet = new CSSStyleSheet();
  function applyResponseColor() {
    const list = site.responseSelectors.join(', ');
    const c = /^#[0-9a-f]{6}$/i.test(cfg.responseColor) ? cfg.responseColor : '#0f9d58';
    try {
      sheet.replaceSync(`:is(${list}), :is(${list}) * { color: ${c} !important; -webkit-text-fill-color: ${c} !important; }`);
    } catch {
      /* invalid selector list */
    }
    ensureSheet();
  }
  function ensureSheet() {
    try {
      if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      /* document not ready yet */
    }
  }
  applyResponseColor();
  // some frameworks reset adoptedStyleSheets
  setInterval(ensureSheet, 1500);
  document.addEventListener('DOMContentLoaded', ensureSheet);
})(__SUG_CONFIG__);
