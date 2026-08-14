# Almost Video Feedback

> *What if you could record video feedback for your AI? Now you almost can.*
>
> **🌐 [Website](https://justinwi.github.io/almost-video-feedback/)  ·  📥 [Install (latest release)](https://github.com/JustinWi/almost-video-feedback/releases/latest)**

A Chrome extension (Manifest V3) for recording **spoken + visual feedback** on a web app and
handing an AI coding agent (Claude Code, etc.) a single file that says exactly what to fix —
with screenshots correlated to what you said and did.

You hit record, talk through what's wrong while you click / select / scroll / circle the mouse
around things, and on stop it writes a session bundle to your Downloads folder and copies a
ready-to-paste prompt (containing the absolute path to `feedback.md`) to your clipboard.

```
Start ▶  →  talk + point at things  →  Stop ⏹  →  paste into your agent  →  it reads the file and does the work
```

---

## How it works

- **Transcription** runs in real time via Chrome's built-in **Web Speech API** (no API key, no
  setup), hosted in a hidden **extension-origin iframe** injected into the page. That gives it a
  foreground document (which Web Speech needs — it doesn't work in an offscreen document) *and* the
  extension's one-time microphone permission (so you're not prompted per site). A higher-quality
  remote engine (Deepgram / AssemblyAI / Whisper) can be added later.
- **Screenshots** are captured at strategically chosen moments and **deduplicated** so the agent
  isn't drowned in near-identical frames. Capture triggers:
  - on start, on new page load, and on in-app (SPA) navigation
  - on click, on text-selection release (the selected text is recorded too)
  - when you **circle / scribble** the mouse around something, or pause after moving it
  - after you scroll and stop
  - a periodic safety-net snapshot
  - manually — the **hotkey** or the floating **📸 Shot** button
  - Near-identical frames are culled with a perceptual hash (dHash + Hamming distance). High-intent
    triggers (start, navigation, selection, circling, manual) are never culled.
  - **Clicks** use a region-aware check: a click is kept when the area *around the pointer* changed
    (a toggle, a menu) **or** the page changed a lot — and dropped when the click changed nothing.
    (Switchable to "always capture" or plain whole-screen dedup in Settings.)
- **Overlay**: a single translucent bar shows the live transcript, a screenshot
  counter, and Pause / Shot / minimize / Stop buttons (plus a **⌫** clear button while a drawing is present). It's
  **draggable** (grab the REC area) and **minimizable** (collapses to a small pill), and its
  position is remembered. It stays put during captures (no flicker); minimize or move it if you want
  it out of a screenshot. The canonical "recording" state is also shown in the toolbar badge (a red ●).
- **On-page drawing** (telestrator): on by default — **right-click and drag** to draw on the page in
  neon pink so the AI can see what you're pointing at. On macOS use **Control-Option-click and drag**
  (a deliberate combo that stays clear of the right-click menu and Control+scroll zoom; a mouse
  right-drag works too). Works **over embedded iframes** too (each frame draws over its own area). The
  marks are painted into the page, so they show up in the screenshots, and a screenshot is captured
  after each drawing. A plain right-click still opens the page's normal menu; **double-click** the draw
  gesture — or the **⌫** button that appears on the overlay — clears (every frame). Turn it off in
  Settings.
- **Mic meter**: the popup shows a live microphone level so you can confirm audio is being picked up.
- **Correlation**: everything is one timestamped timeline (speech, screenshots, navigations),
  persisted to IndexedDB as it happens. On stop, each spoken segment is attached to the nearest
  screenshot in time and the whole thing is rendered chronologically.
- **Loom import**: on a `loom.com/share/...` page, click *Import this Loom video* in the popup to
  turn the page's transcript + frames into the same `feedback.md` bundle — no live recording needed.

## Output

Written to `Downloads/ai-feedback/session-YYYYMMDD-HHMMSS/`:

```
feedback.md          # agent-facing: instructions + chronological entries with screenshots
session.json         # the same data, structured, for programmatic use
screenshots/0001.png
screenshots/0002.png
...
```

`feedback.md` interleaves, in order: what you did, what you said at that moment, the page URL, the
clicked/selected element, and the screenshot. The clipboard gets a prompt like:

> I recorded visual + spoken feedback on my web app. Please read the feedback file and address
> each item. Screenshots are referenced relative to the file, in the same folder.
>
> Feedback file: `C:\Users\you\Downloads\ai-feedback\session-…\feedback.md`

Paste that straight into Claude Code.

---

## Install (load unpacked)

**Easiest:** download `almost-video-feedback.zip` from the
[latest release](https://github.com/JustinWi/almost-video-feedback/releases/latest), unzip it,
and load that folder (steps below). Or clone this repo and load the folder directly.

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the folder (the one containing `manifest.json`).
4. Pin the extension so you can see the toolbar button + recording badge.

Requires Chrome 116+.

## Microphone

Transcription runs in a hidden **extension-origin iframe**, so you grant the microphone to the
extension **once** (Chrome's prompt the first time you record, or via the toolbar popup's mic meter)
and it's reused on every site — no per-website prompts. When you start, the overlay shows a
**"Starting microphone…"** spinner and only switches to the live **REC** state once the recognizer is
actually capturing audio — so it never looks like it's recording before the mic is on.

Some sites ship a `Permissions-Policy` header that blocks microphone use for **all** embedded
frames, which would silently kill the iframe recognizer no matter what you've granted. When that
happens the extension automatically moves transcription into its own offscreen document (which no
site policy can touch) and keeps going. If transcription still can't run, the overlay says exactly
why — mic permission missing (open the toolbar popup and pick **"Allow on every visit"**, not
"Allow this time"), the site blocking it with the fallback unavailable, or Chrome's speech service
being down — and screenshots keep recording either way.

## Privacy & security

Short version: **your recordings stay on your machine.** There is no backend — no servers, accounts,
or telemetry. The extension makes **no network requests of its own** (independently audited; the only
`fetch` is of a local `data:` URL). Full
[privacy policy](https://justinwi.github.io/almost-video-feedback/privacy.html).

- **Where data lives:** screenshots, transcripts, and the bundle are written to your **Downloads**
  folder and the extension's **local storage** (IndexedDB, which keeps your last 40 sessions until you
  clear them). Nothing leaves your device unless *you* share a zip.
- **Microphone / transcription:** transcription uses **Chrome's built-in Web Speech API**. In Chrome
  that means your spoken audio is sent to the browser's speech service (Google) to be turned into
  text — the same as voice typing. The extension itself transmits nothing; this is the browser's
  behavior. (A future release may add an offline/remote engine you can choose.)
- **Permissions:** it requests broad permissions because it has to work on *any* site you review —
  `<all_urls>` (inject the overlay + read the page you're reviewing), screenshot the active tab, the
  microphone, downloads, and local storage. It only acts on the tab you're actively recording. The
  lightweight **drawing layer** (a canvas you draw on) is also injected into sub-frames/iframes so you
  can draw over embedded content; like the rest of the extension it makes no network requests.
- **Reviewing untrusted pages:** `feedback.md` includes text copied from the page (URLs, element
  labels, your selections). If you record on a page with attacker-controlled content, that text ends
  up in the file you paste into your AI agent — so treat the output as you would any untrusted input,
  and glance at it before handing it to an agent.
- **Auditable:** MIT-licensed, no dependencies, no build step, no minified code. Found something?
  See [SECURITY.md](SECURITY.md).

## Using it

1. Open the tab you want to review (any normal `http`/`https` page, including `localhost`).
2. Click the toolbar button — by default it **starts recording immediately** (no menu), so you're
   talking in one click. (Prefer to see the menu first? Turn off *"Clicking the toolbar icon starts
   a recording"* in Settings.) You can also press the hotkey.
3. Talk through your feedback while you interact with the page. A translucent bar at the bottom
   shows the live transcript and flashes "📸 Screenshot N" when one is captured.
4. Press the hotkey or the **📸 Shot** button any time you want to force a capture.
5. Hit **⏸ Pause** on the overlay to step away — the mic turns off and nothing is captured until you
   press **▶** to resume (the bar shows **PAUSED**).
6. Click **Stop** (in the popup or the overlay). The popup pops open showing **"Recording saved"**,
   the bundle is written, and the agent prompt (with the file path) is copied to your clipboard
   automatically. The popup also lists your **last 5 recordings** — click one to view it or copy its
   prompt, or open the full **Recordings** library to view/share any of them.

> **Tip:** clicking the toolbar icon **while recording** stops the recording automatically (the
> menu opens straight to the saved result). Use the on-page overlay or the hotkey to control a
> recording without stopping it.

### Hotkeys (default — rebindable at `chrome://extensions/shortcuts`)

| Action | Windows/Linux | macOS |
|---|---|---|
| Start / stop recording | `Ctrl+Shift+Y` | `⌘+Shift+Y` |
| Force a screenshot | `Ctrl+Shift+U` | `⌘+Shift+U` |

### Recordings library & sharing

Click **📁 Recordings** in the popup (or **View & share** after a recording) to open the library.
Each past session is listed with its date, duration, and counts; expand one to see every screenshot
with the words you spoke around it and the full transcript.

**Pruning screenshots:** in the expanded view, click any screenshot to select it (shift-click for a
range, or use **Select all**), then **🗑 Delete selected** to drop the ones you don't want. This
updates the library copy used for viewing and sharing — the original files already in Downloads are
left untouched. (Click a screenshot's image to open it full-size.)

Per session you can also:

- **Share** — bundles `feedback.md` + `session.json` + all screenshots into a `.zip` and opens your
  OS share sheet (email, WhatsApp, etc.) via the Web Share API; if that's unavailable it downloads
  the zip so you can attach it manually.
- **Copy prompt** — copies the ready-to-paste agent prompt with the file path.
- **Delete** — removes it from the library (files already in Downloads are left alone).

The library keeps the most recent 40 sessions (older ones are pruned automatically).

### Settings

Right-click the extension → **Options** (or the popup's **Settings** link) to tune: whether clicking
the toolbar icon starts a recording instantly, transcription language, which triggers are active,
capture format (PNG/JPEG), the dedup aggressiveness, how **click** screenshots dedup (smart /
always / global), whether **on-page drawing** is enabled, the safety cap, and the timing thresholds
for scroll/dwell/circle detection.

---

## Limitations

- Can't record `chrome://` pages, the Chrome Web Store, or other extension pages.
- Web Speech sends audio to Google's servers (it's not truly offline). A private/offline engine is
  on the roadmap via the swappable transcription interface.
- Files land in **Downloads** (extensions can't write to arbitrary paths). Writing straight into a
  project repo would need a native-messaging host or a small local companion app — a future option.
- Screenshots appear briefly in Chrome's downloads UI as they're written on stop.
- Recording follows one tab/window; switching to a different tab mid-session is not the intended flow.

## Development

```bash
npm test       # pure-logic unit tests (image hash, gesture math, exporter)
npm run verify # manifest references + syntax-check every JS file
npm run icons  # regenerate the toolbar PNGs
```

No build step and no dependencies — the `src/` tree loads unpacked as-is.

### Layout

```
manifest.json
src/
  common/      protocol.js (message types), config.js (settings + storage)
  background/  service-worker.js (orchestrator) + capture, dedup hash, session store (IndexedDB),
               exporter (feedback.md/json), downloads (write + resolve absolute path)
  offscreen/   clipboard write (created on stop)
  content/     overlay UI + Web Speech transcription + input tracking + capture coordination
  popup/  options/    UI pages
docs/superpowers/specs/    design spec
test/        node test runner
scripts/     icon generator + verifier
```

## Contributing

PRs and ideas welcome — it's open source (MIT). There's no build step, so getting started is just
"load unpacked + edit + reload". See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the dev loop, the
architecture, and good first contributions (new screenshot triggers, a remote transcription engine,
output tweaks). Run `npm test && npm run verify` before opening a PR.

**Making changes with an AI agent?** Read **[AGENTS.md](AGENTS.md)** (and `CLAUDE.md`) — it has the
conventions and the verification checklist that keep the extension loadable and in good standing.

## Roadmap

- Pluggable remote transcription (Deepgram / AssemblyAI / Whisper) for higher accuracy + privacy.
- Optional native-messaging host to drop the bundle directly into a target repo.
- Smarter screenshot selection (OCR-aware diffing, element-change detection).
