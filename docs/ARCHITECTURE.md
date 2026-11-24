# Architecture

Sensitive Upload Guard is a standalone Electron desktop app. It does **not** use a browser
extension. It launches a real Google Chrome (or Edge / Brave / Chromium) with a dedicated
profile and controls it from the outside over the **Chrome DevTools Protocol (CDP)**, the same
protocol Playwright and Puppeteer use. Every prompt and file is checked in the desktop app, and
the user decides in a **native OS dialog** before anything leaves the browser.

```
┌──────────────────────────── Sensitive Upload Guard (Electron, Node) ───────────────────────────┐
│                                                                                                 │
│  Control panel (renderer)      Guard ──────────────── TabGuard (one per tab) ────┐              │
│  status · toggles · colour     launches Chrome,       • injects page agent       │              │
│  activity list                 auto-attaches to       • binding  ◄── asks        │              │
│        ▲  IPC                  every tab              • Fetch backstop ◄── paused │ requests     │
│        │                                                                         │              │
│  DecisionService ◄──────────── prompt / file verdicts ◄────────────────────────── │              │
│  queue · dedupe · memory                                                          │              │
│        │                       Inspectors: text · PDF (pdf.js) · image (Tesseract OCR)          │
│        ▼                                                                                        │
│  Native dialog (NSAlert sheet / Windows Task Dialog / GTK)   [ Cancel ]  [ Continue ]           │
└───────────────────────────────────────────▲────────────────────────────────────────────────────┘
                                            │ CDP over WebSocket (127.0.0.1 only)
┌───────────────────────────────── Google Chrome (dedicated profile) ─────────────────────────────┐
│  chatgpt.com / perplexity.ai tab                                                                │
│   ├─ page's own JavaScript (main world)                                                         │
│   └─ isolated world: page agent  ── capture listeners: Enter, Send click, submit,              │
│                                      file input, drop, paste · response colour stylesheet       │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Components

| Module | Role |
|---|---|
| `src/main/main.js` | App lifecycle, control-panel window, IPC, audit log. |
| `src/main/browser/launcher.js` | Finds a Chromium browser, launches it with `--remote-debugging-port` on a random localhost port and a dedicated `--user-data-dir`. |
| `src/main/cdp/connection.js` | Small CDP client: one WebSocket, flattened sessions (one per tab). |
| `src/main/guard/guard.js` | Browser-level controller. `Target.setAutoAttach` with `waitForDebuggerOnStart` makes every new tab wait until it is guarded. |
| `src/main/guard/tab-guard.js` | Per-tab setup: agent injection, the binding, the Fetch backstop, file inspection, replies to the agent. |
| `src/agent/page-agent.js` | Runs inside the page in an **isolated world**. Intercepts user actions and asks the app. |
| `src/agent/typeahead-guard.js` | Tiny main-world hook that drops typeahead WebSocket frames containing the marker (Perplexity sends keystrokes to a suggestion service). |
| `src/main/guard/decision-service.js` | Turns verdicts into one dialog at a time, merges duplicates, remembers recent decisions, emits audit events. |
| `src/main/inspect/*` | Marker matching, file-type sniffing, text / PDF / image inspection, request-body decoding. |
| `src/main/ui/confirm-dialog.js` | The native Continue / Cancel dialog. |
| `src/main/sites.js` | All per-site knowledge (hosts, endpoints, selectors) as data. |

## Prompt interception (two layers)

### Layer 1: in the page (primary)

The agent is registered with `Page.addScriptToEvaluateOnNewDocument({ worldName })`, so it runs
in every document **before any page script**, in an isolated JavaScript world. It shares the DOM
with the page but none of its globals: the page cannot see or tamper with it. It registers
capture-phase listeners on `window`, so it sees events before the page's own handlers:

* `keydown` Enter (no Shift, not during IME composition) inside a textarea / contenteditable,
* `click` on a send button (site selectors plus a generic "send/submit" heuristic),
* `submit` on a form that contains the composer.

The prompt text is checked locally first with the same normalisation as the app. **Clean
prompts are never delayed or touched.** If the marker is present, the event is stopped
(`preventDefault` + `stopImmediatePropagation`) and the agent calls a CDP binding, which exists
only in its isolated world. The app shows the dialog and answers through `Runtime.evaluate` in
that world's context.

* **Continue**: the agent replays the submission (clicks the send button, or `requestSubmit()`,
  or re-dispatches Enter). The site sends exactly what the user typed.
* **Cancel**: nothing is sent. The text stays in the composer, so the user can edit and send
  again. A small toast (closed shadow DOM) confirms the block.

### Layer 2: on the network (backstop)

Every tab has `Fetch.enable` with patterns for the sites' prompt-submission endpoints
(`/backend-api/…conversation`, `/rest/sse/perplexity_ask`, …). Matching requests are **paused**
in the browser, and their bodies are decoded (JSON at any depth, form-encoded, multipart,
chunked `postDataEntries`, `\u`-escaped) and checked for the marker. This catches anything the
DOM layer could not see: a site redesign, a keyboard shortcut we don't handle, a "regenerate"
button.

* Continue → `Fetch.continueRequest` (the original bytes are sent unchanged).
* Cancel → `Fetch.failRequest('BlockedByClient')`. The request never leaves the browser.

**No double dialogs:** after Continue in layer 1, the network layer finds the same prompt in
the outgoing body and reuses the decision for 30 s. A Cancel is remembered for only 3 s, enough
to absorb duplicate requests of one submission (Perplexity sends the query to two endpoints at
once) while a deliberate retry asks again. A user action seen by layer 1 **always** gets a
dialog.

## File interception

Files are caught **when the browser hands them to the page**. Both sites upload immediately
on selection, so that is before any byte is sent.

| Path | How it is held | Continue | Cancel |
|---|---|---|---|
| File picker (`<input type=file>`) | `input` + `change` stopped in capture phase | the same events are re-fired on the same input | input value cleared; the page never saw the files and the user can pick again |
| Drag and drop | `drop` stopped; files copied into a new `DataTransfer` (the original is unreadable after the handler) | `drop` re-dispatched on the original target with the copy | `dragleave` dispatched so the site's drop overlay closes |
| Paste (screenshots, copied files) | `paste` with files stopped and copied | `paste` re-dispatched with the copy | dropped |

The agent reads the files (`FileReader`) and sends them to the app through the binding (up to
50 MB, configurable). Larger files cannot be inspected and get a dialog, so they fail closed.
Several files in one action produce **one** dialog listing the flagged ones. The decision
covers the whole action.

### Inspectors

`inspectFile()` sniffs the real type from magic bytes (not the name or MIME type, which are
easy to spoof), then runs, from cheapest to most expensive:

* **Every file**: raw byte scan for the marker in UTF-8 / UTF-16LE / UTF-16BE (catches PNG text
  chunks, EXIF/XMP, uncompressed PDF streams).
* **Text** (any text-like file: .txt, .md, .csv, .json, code, …): BOM-aware decoding (UTF-8,
  UTF-16 with and without BOM, Latin-1 fallback).
* **PDF** with pdf.js: metadata, the text layer of every page (handles compression, font
  encodings, hex strings), annotations / form fields, then **OCR of rendered pages that contain
  images** (scanned documents, screenshots pasted into PDFs). Text-only pages are not OCR'd.
  Password-protected or corrupt PDFs → "could not be inspected" dialog.
* **Images** (PNG, JPEG, GIF, WebP, BMP, TIFF, AVIF): decoded with `@napi-rs/canvas`,
  flattened, greyscaled and scaled to an OCR-friendly size, then **Tesseract** (bundled
  `eng` model: fully offline, nothing leaves the machine). A second, inverted pass handles
  dark-mode screenshots.

Marker matching (`marker.js`): typed text and text layers use **exact matching after Unicode
normalisation** (NFKC, case-insensitive, zero-width / bidi characters removed). So
`walled_sensitive`, full-width letters, or a zero-width space hidden inside the marker are
still caught. OCR text uses a **fuzzy match**: letters only, common OCR confusions mapped (0→O,
1→I, 5→S, …), one remaining edit allowed. That tolerates a misread underscore or letter
without matching phrases like "WALLET SENSITIVITY".

## Native confirmation dialog

`dialog.showMessageBox` is a real OS dialog: **NSAlert** on macOS, **Task Dialog** on Windows,
**GtkMessageDialog** on Linux. It is not HTML. It says whether the content is a **text prompt**
or a **file**, shows the prompt (truncated, control/bidi characters stripped) or the file
name(s), size and where the marker was found, and has two buttons: **Continue** and **Cancel**.

* Cancel is the default button and also what Esc does (safe default).
* The app steals focus first so the dialog appears over Chrome. On macOS it is shown as a sheet
  on the control panel: unlike a parentless alert, a sheet is asynchronous, so the app keeps
  serving other tabs and the timeout can close it.
* Unanswered for 120 s (configurable) → treated as Cancel.
* Dialogs are queued: never more than one at a time, even with several tabs.

## Response colour

The agent adds a constructed stylesheet to `document.adoptedStyleSheets` that colours
assistant messages and all their descendants
(`[data-message-author-role="assistant"]`, `.prose[data-renderer="lm"]`, …). Constructed
stylesheets are not subject to the sites' CSP (an injected `<style>` would be), and they apply
to answers that stream in later without a MutationObserver. The colour can be changed live
from the control panel.

## Fail-safe behaviour

| Situation | Result |
|---|---|
| App crashes / disconnects while a decision is pending | agent's own timer → treated as Cancel |
| Error while checking a paused submission request | request blocked (can be retried, a leak cannot be undone) |
| Supported file cannot be inspected (corrupt, encrypted, too big) | dialog: "could not be inspected" |
| Unsupported format (zip, docx, …) | raw byte scan only, then allowed (out of scope of the task) |
| Tab opened later / new window | auto-attached and paused until guarded (`waitForDebuggerOnStart`) |
| App quits | the guarded browser is closed, so no unguarded window is left looking protected |

## Privacy and security

* All inspection is local (pdf.js, Tesseract with a bundled model). Nothing is uploaded.
* The audit log (`<userData>/logs/audit.jsonl`) stores decisions, file names and SHA-256
  hashes, and only the **length and hash** of prompts, never their content.
* The DevTools port binds to 127.0.0.1 with a random port, and the guarded profile is separate
  from the user's normal profile (Chrome 136+ refuses remote debugging on the default profile).
* The binding and isolated-world names are random per run, and the page cannot call the
  binding.
* The control panel runs with `contextIsolation`, `sandbox`, no Node integration and a strict
  CSP, and it cannot navigate or open windows.

## Alternatives considered

* **Browser extension**: ruled out by the brief.
* **System-wide HTTPS proxy (MITM)**: works with any browser, but needs a root CA installed,
  breaks with certificate pinning and QUIC, gets flagged by Cloudflare's TLS fingerprinting, and
  on Cancel can only fail the request, so the user loses their prompt. File uploads go to
  pre-signed storage URLs after the file is already "attached" in the UI. Recolouring responses
  would mean rewriting CSP-protected HTML.
* **Embedding the sites in an Electron `<webview>`**: that is a separate browser, not "the web
  apps accessed through a web browser", and Google / Cloudflare sign-in flows often reject
  embedded browsers.
* **OS accessibility / keyboard hooks**: can see keystrokes but not file contents or network
  traffic, and cannot reliably hold an action.

CDP gives the right hooks at the right moments (before page scripts, before network
transmission, with the files in hand) in the user's real browser.

## Known limitations

* Only the Chromium browser launched by the app is guarded. Firefox and Safari are not
  supported (Firefox could be added through WebDriver BiDi, which has equivalent primitives).
  In a company rollout, browser policy would make the guarded profile the only way to reach
  these sites.
* Out-of-process iframes and service workers are not attached. Neither site submits prompts
  or files from them today.
* The send-button and response selectors are site-specific and will need updating when a site
  changes its UI. They are data in `sites.js`. The network backstop keeps prompts safe in the
  meantime, and the file hooks are generic DOM events that do not depend on selectors.
* Enter-to-send is assumed. If a user switches a site to "Enter inserts a newline", pressing
  Enter on a marker prompt shows the dialog, and Continue then submits.
* The typeahead guard runs in the page's main world (only on Perplexity). It is the only piece
  page scripts could observe.
