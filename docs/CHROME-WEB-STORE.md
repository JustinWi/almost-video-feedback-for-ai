# Chrome Web Store submission kit

Everything you need to publish **Almost Video Feedback** to the Chrome Web Store. The parts I could
prepare are below as copy-paste-ready text; the parts only you can do (register, upload, submit) are
in the checklist at the end.

---

## What's already prepared

- ✅ **Upload package:** `dist/almost-video-feedback-store.zip` — run `npm run pack:store` to (re)build it. The manifest is at the zip root (the store requires this).
- ✅ **Privacy policy (hosted, required):** https://justinwi.github.io/almost-video-feedback/privacy.html
- ✅ **128×128 icon:** included in the package.
- ✅ **Store images:** four 1280×800 screenshots + the promo tile + marquee are in `docs/store/`. Regenerate the promo images anytime with `node scripts/gen-store-images.cjs` (source: `docs/store-assets.html`).
- ✅ All listing copy, permission justifications, and the data-disclosure answers — below.

---

## Listing fields (copy/paste)

**Name**

```
Almost Video Feedback
```

**Summary** (≤132 chars)

```
Record spoken + visual feedback on any web app, then hand your AI agent one file of screenshots tied to what you said.
```

**Category:** `Developer Tools`  ·  **Language:** `English`

**Detailed description**

```
Describing UI bugs to an AI coding agent is tedious: you type a wall of text, take a screenshot, dig
it out of Downloads, drag it in, and explain which part you mean — for every single issue.

Almost Video Feedback turns that into talking. Hit record, describe what's broken while you click,
scroll, and select on the page — and circle or draw right on the page to point at what's wrong — then
stop. The extension transcribes what you said and automatically captures the right screenshots (your
drawings included), bundles everything into one file, and copies a ready-to-paste prompt to your
clipboard. Paste it into your AI agent (Claude Code, Cursor, Copilot, or any tool that reads files)
and it has your words and the screenshots, in order.

Already recorded a Loom? Open the Loom share page and click "Import this Loom video" — it turns the
Loom's transcript and frames into the exact same bundle, with no re-recording.

WHAT IT DOES
• Real-time voice transcription while you record (built into your browser — no API key).
• Smart screenshots on clicks, text selection, scroll-stops, and mouse-circling — deduplicated so
  your agent isn't flooded with near-identical frames (a region-aware check still catches small
  changes like a toggled control).
• Draw on the page — right-drag (Control-Option-drag on a Mac) to circle and scribble what's wrong;
  your marks are painted into the screenshots, even over embedded iframes.
• Pause and resume anytime — the mic goes quiet and nothing's captured until you're ready.
• A correlated bundle: each screenshot is tied to what you said at that moment, the page URL, and the
  element you touched.
• One-paste handoff: on stop, a prompt + the file path are already on your clipboard.
• A recordings library to review past sessions, fix mis-transcribed words, prune screenshots, share a
  session as a zip, or delete a recording you don't need.
• Import a Loom: turn an existing Loom review video (its transcript + frames) into the same bundle.

YOUR DATA STAYS ON YOUR MACHINE
There are no servers, accounts, or analytics. Recordings are saved to your Downloads folder and the
extension's local storage; nothing is sent to the developer. Transcription uses Chrome's built-in
speech feature, which (like voice typing) sends audio to the browser's speech service. Full details:
https://justinwi.github.io/almost-video-feedback/privacy.html

Open source (MIT) and dependency-free — read every line at
https://github.com/JustinWi/almost-video-feedback

Made by teachinge.org — https://teachinge.org
```

**Single purpose** (the dashboard asks for one)

```
Turn a user's feedback about a web page — recorded live (spoken narration + screenshots, with
optional on-page drawing) or imported from an existing Loom video — into a single local file
(a transcript plus correlated screenshots) that the user can hand to an AI coding agent.
```

**Privacy policy URL**

```
https://justinwi.github.io/almost-video-feedback/privacy.html
```

**Homepage / support URL**

```
https://justinwi.github.io/almost-video-feedback/
```

**Contact / support email** (public, on the listing — distinct from the account you log in with)

```
help@teachinge.org
```

---

## Permission justifications (the review form asks per item)

Paste these into the "Permission justification" boxes.

| Permission | Justification |
|---|---|
| **Host permission `<all_urls>`** | The user can record feedback on any website they're reviewing, so the content script (recording overlay, input tracking, and the on-page drawing layer — which also runs in sub-frames so the user can draw over embedded content) and `captureVisibleTab` must be able to run on any URL. It also covers `loom.com` for the Loom-video import (reading the page's transcript and capturing video frames). The extension acts only on the single tab the user explicitly starts recording on or imports from, and only during that action. |
| `tabs` | To capture the visible area of the tab (`captureVisibleTab`) — both for live-recording screenshots and for grabbing frames from an imported Loom video — and to read that tab's URL and title so each screenshot can be labeled in the feedback file. |
| `activeTab` | To operate on the user's current tab when they start a recording or a Loom import from the toolbar. |
| `scripting` | To inject the extension's content scripts (recording overlay, drawing layer, Loom-import bridge) into a tab that was already open before the extension loaded, when the user starts a recording or import there. Only the extension's own bundled files are injected — no remote or generated code. |
| `downloads` | To save the feedback bundle (`feedback.md`, `session.json`, and the screenshot PNGs) to the user's Downloads folder. |
| `downloads.ui` | To briefly hide Chrome's download shelf while the bundle is written, so it doesn't pop up over the popup. Restored immediately after. |
| `storage` | To store the user's settings and the local library of recent recordings. |
| `offscreen` | Two uses: (1) copy the ready-to-paste prompt to the clipboard after a recording is saved, and (2) run the microphone transcription (Web Speech) when the recorded page's `Permissions-Policy` header blocks microphone use inside embedded frames, which would otherwise silently disable the transcript. Audio is processed by Chrome's built-in speech API exactly as in the normal path and is never stored or transmitted by the extension. |
| `alarms` | For the optional periodic "safety-net" screenshot during a recording. |
| `webNavigation` | To take a screenshot when the recorded tab navigates to a new page, so page changes are captured. |
| `clipboardWrite` | To copy the agent prompt (with the file path) to the clipboard when a recording finishes. |

**Are you using remote code?** → **No.** No `eval`, no remotely-hosted scripts, no dynamically
fetched code. All code is in the package; MV3's default CSP is enforced.

---

## Data-use disclosures (the "Privacy practices" tab)

Answer truthfully — these are the expected answers for this extension:

- **What user data do you collect?** The extension *handles* (locally) "Website content" (screenshots
  and page text of the page being reviewed — and, for a Loom import, the Loom page's existing
  transcript and video frames) and audio/"Personal communications" (the user's spoken feedback,
  transcribed, when recording live; a Loom import uses no microphone). It does **not transmit** any of
  this to the developer.
- **Is any of the data sold to third parties?** → **No.**
- **Is the data used or transferred for purposes unrelated to the item's single purpose?** → **No.**
- **Is the data used or transferred to determine creditworthiness or for lending?** → **No.**
- **Three required certifications:** check all three (no selling, single-purpose only, no
  creditworthiness use).
- In the privacy-practices notes field, you can paste: *"All recording data stays on the user's
  device (Downloads + local storage). The extension has no backend and transmits nothing to the
  developer. Voice transcription uses Chrome's built-in Web Speech API, which sends audio to the
  browser's speech service (Google); this is disclosed in the privacy policy."*

> Note: because of `<all_urls>`, the store listing will show "Read and change all your data on all
> websites." That's expected for a screenshot/review tool — the privacy policy + description explain
> why and that nothing leaves the device.

---

## Images you need (sizes)

**✅ Ready-to-upload 1280×800 product screenshots are in [`docs/store/`](store/):**
1. `01-record-on-your-app.png` — the recording overlay + a drawn circle on a real-looking dashboard.
2. `02-recordings-library.png` — the recordings library with screenshots + transcript.
3. `03-control-center.png` — the toolbar popup (recent recordings, saved result).
4. `04-draw-and-loom.png` — the two new ways in: draw on the page, or import a Loom video.

Upload any 1–5 of them (all four recommended).

| Asset | Size | Status |
|---|---|---|
| Store icon | 128×128 | ✅ in package |
| Screenshots (×4) | 1280×800 | ✅ `docs/store/01-…` … `04-draw-and-loom.png` |
| Small promo tile | 440×280 | ✅ `docs/store/promo-tile-440x280.png` |
| Marquee promo | 1400×560 | ✅ `docs/store/marquee-1400x560.png` |

The promo tile, marquee, and the draw-and-loom screenshot regenerate from `docs/store-assets.html` — run **`node scripts/gen-store-images.cjs`** (headless Chrome) after any copy/feature change. (Screenshots 01–03 are the original in-context renders; recapture them only if you want them to show the pause button and drop the old elapsed-timer.)

---

## Your checklist (the parts only you can do)

1. **Register** at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/) signed in as **justin@teachinge.org** — one-time **$5** fee. (If the console is blocked, enable the Chrome Web Store developer console for your domain in the [Google Admin console](https://admin.google.com) — you own it.) Set the **publisher display name** to **teachinge.org**.
2. Click **New item** → upload **`dist/almost-video-feedback-store.zip`**.
3. Fill **Store listing**: paste the Name, Summary, Description, Category, Language above; add the icon (auto from package), screenshots + promo tile (from `store-assets.html`), and the **homepage** URL.
4. Fill **Privacy practices**: paste the **single purpose**, the **permission justifications**, set **remote code = No**, the **privacy policy URL**, and the **data-use** answers above.
5. **Save draft → Submit for review.** First reviews typically take a few days; broad permissions can add scrutiny, which the justifications above are written to satisfy.
6. After it's approved, update the website's install buttons to point to the Web Store listing (tell me the URL and I'll switch them over).

When you're ready to ship updates later: bump `version` in `manifest.json`, run `npm run pack:store`, and upload the new zip in the dashboard.
