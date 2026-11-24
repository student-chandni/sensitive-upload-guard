# Sensitive Upload Guard

A lightweight **desktop DLP (Data Loss Prevention) app** for the ChatGPT and Perplexity web
apps. It watches text prompts and file uploads in the browser, finds the marker
**`WALLED_SENSITIVE`** in prompts, **text files, PDFs (including scanned ones) and images
(OCR)**, and asks for confirmation in a **native desktop dialog** before anything is sent. It
also recolours every AI-generated response on both sites.

* Standalone desktop app (Electron). **No browser extension or add-on.** It controls the user's
  real Google Chrome over the Chrome DevTools Protocol.
* Content is inspected **before it is transmitted**: prompts before submission, files before
  the page even receives them.
* **Continue** sends the original prompt or file unchanged. **Cancel** blocks it and leaves the
  user free to edit and try again.
* All inspection (pdf.js, Tesseract OCR with a bundled model) runs locally. Nothing leaves
  the machine.

How it works, the design decisions and the trade-offs: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Requirements

* **Node.js 20+** and npm
* **Google Chrome** (Microsoft Edge, Brave or Chromium also work)
* macOS, Windows or Linux. Developed and tested on macOS (Apple Silicon) with Chrome 158.

## Setup

```bash
git clone <this repo>
cd sensitive-upload-guard
npm install        # also downloads Electron and the offline OCR model
npm start
```

If your npm skips install scripts and Electron complains that its binary is missing, run
`node node_modules/electron/install.js` once.

## Using it

1. `npm start` opens the **control panel** and launches a **protected Chrome window** with
   ChatGPT and Perplexity in two tabs. It uses its own browser profile, so **sign in to
   ChatGPT / Perplexity once in that window** and it is remembered. Logged-out use works too.
2. Use the sites normally. Prompts and files without the marker go through **without any
   interruption**.
3. Send a prompt containing `WALLED_SENSITIVE`, or attach a file that contains it (file picker,
   drag and drop, or paste). A native dialog appears:

   ```
   ⚠  Sensitive content detected in a text prompt
      You are about to send a prompt to ChatGPT that contains the marker "WALLED_SENSITIVE".
      Prompt: "Summarise this memo WALLED_SENSITIVE in one line"
                                                         [ Cancel ]  [ Continue ]
   ```
   For files it names each flagged file and where the marker was found, e.g.
   `• contract.pdf (182 KB): marker found in page 3 image (OCR)`.
4. **Continue** → the prompt or upload goes ahead unchanged. **Cancel** → nothing is sent. The
   prompt stays in the box, and the file picker is cleared so you can choose again.
5. AI responses on both sites are shown in the colour picked in the control panel (green by
   default).

The control panel also has: on/off switches for prompt inspection, file inspection and OCR; the
response colour picker; an activity list (what was caught, how, and what was decided); and
links to the **sample files** and the logs.

### Sample files for testing / the demo

`fixtures/` contains ready-made files (open them from the panel's **Sample files** link):

| File | Contains marker | Found by |
|---|---|---|
| `sensitive-notes.txt`, `sensitive-utf16.txt`, `sensitive-data.csv` | yes | text |
| `sensitive-report.pdf` | yes (page 2) | PDF text layer |
| `sensitive-scanned.pdf` | yes, as pixels only | OCR of the rendered page |
| `sensitive-screenshot.png`, `sensitive-darkmode.png`, `sensitive-photo.jpg` | yes, as pixels only | OCR |
| `clean-notes.txt`, `clean-report.pdf`, `clean-screenshot.png` | no | pass straight through |

Regenerate them with `npm run fixtures`.

## Tests

```bash
npm test            # unit tests: matching, decoders, inspectors on every fixture, decision logic, dialog text
npm run test:e2e    # end-to-end: real Chrome + the real app + a local mock chat page
npm run smoke       # live check against the real chatgpt.com and perplexity.ai (diagnostic)
```

The **end-to-end suite** (32 checks) drives a real Chrome. It covers Enter and Send-button
submission, Cancel/Continue for prompts, a zero-width-space evasion attempt, the network
backstop, file picker uploads of every supported type (text, text PDF, scanned PDF, PNG,
JPEG), multi-file uploads, drag and drop, paste, and response recolouring. Native dialogs
cannot be clicked by a script, so the tests set `SUG_AUTO_DECISION_FILE` and the app prints
what the dialog would have said and answers from that file. Everything else runs exactly as in
normal use.

The **smoke test** does the same against the live sites (logged out). On 23 Nov 2026 it
passed on both ChatGPT and Perplexity: marker prompt → dialog, Cancel blocks before any
request, Continue sends exactly once, the response is recoloured, a sensitive PDF uploaded
through the site's own file input is stopped, and no marker text leaks through Perplexity's
typeahead WebSocket.

## Configuration

Settings live in `settings.json` in the app's data folder (open it with **Logs** in the
panel). Most are also in the UI.

| Key | Default | Meaning |
|---|---|---|
| `responseColor` | `#0f9d58` | colour of AI responses |
| `inspectPrompts` / `inspectFiles` / `ocrEnabled` | `true` | feature switches |
| `dialogTimeoutSec` | `120` | unanswered dialog → Cancel (0 = wait forever) |
| `onInspectionError` | `"ask"` | a supported file that cannot be read (corrupt, encrypted, > limit): `"ask"` (fail closed) or `"allow"` |
| `maxInspectBytes` | 50 MB | largest file that is inspected |
| `maxOcrPages` | `10` | max image-bearing PDF pages to OCR |
| `browserPath` | auto | path to a specific Chromium-based browser |
| `closeBrowserOnQuit` | `true` | quitting the app closes the protected browser |

Developer environment variables: `SUG_DEBUG=1` (verbose log), `SUG_ATTACH_PORT=<port>`
(attach to an already-running Chrome started with `--remote-debugging-port`),
`SUG_USER_DATA=<dir>` (separate data folder).

## Troubleshooting

* **"No Chromium-based browser found"**: install Chrome, or set `browserPath`.
* **The dialog did not appear in front**: it is attached to the control panel window. The app
  brings itself forward, but if the panel is on another desktop/space, switch to it.
* **A site shows "Just a moment…" (Cloudflare)**: complete the check in the protected window
  as usual. It happens on new profiles or IPs.
* **Nothing is guarded**: only the protected window opened by the app is guarded, not your
  normal Chrome. The panel shows how many guarded tabs are open.

## Project layout

```
src/main/            Electron main process
  main.js            app lifecycle, control panel, IPC, audit log
  browser/           find and launch Chrome with a dedicated profile
  cdp/               minimal Chrome DevTools Protocol client
  guard/             browser/tab controllers, network backstop, decision queue
  inspect/           marker matching, text / PDF / image (OCR) inspectors, body decoder
  ui/                native confirmation dialog
  sites.js           per-site endpoints and selectors (data, not code)
src/agent/           scripts injected into the pages (isolated world + typeahead guard)
src/renderer/        control panel UI
test/                unit tests, end-to-end test, mock chat page
scripts/             fixture generator, live smoke test, postinstall helper
fixtures/            sample files with and without the marker
docs/ARCHITECTURE.md design, interception and enforcement details, limitations
```
