# AGENTS.md — guide for AI agents working on this repo

This file tells an AI coding agent (Claude Code, Cursor, Copilot, etc.) how to make changes to
**Almost Video Feedback** without breaking it. Follow it so the extension stays loadable,
publishable, and in good standing. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

A Manifest V3 Chrome extension that records spoken + visual feedback on a web page and writes a
single bundle (`feedback.md` + `session.json` + screenshots) for an AI coding agent to act on.
Architecture overview: [README.md](README.md). Design spec: `docs/superpowers/specs/`.

## Golden rules (don't violate these)

1. **No build step, no runtime dependencies.** The `src/` tree must load unpacked as-is. Do **not**
   add a bundler, framework, or npm runtime dependency, and do **not** introduce `import`/`export`
   in the service worker or content scripts.
   - Service worker = a **classic** worker that pulls modules via `importScripts(...)`.
   - Content scripts share one isolated-world scope; split files attach to `globalThis` (e.g.
     `SCF`, `SCF_GESTURE`) instead of importing.
   - Extension pages (popup/options/history/offscreen) use classic `<script src>`.
2. **Cross-context messages go through `src/common/protocol.js`.** Add a constant there; never
   hard-code message-type strings.
3. **Tunable behavior goes through `src/common/config.js`** (+ a control in the options page) —
   don't scatter magic numbers in logic.
4. **Pure logic uses the dual-export pattern and gets a test.** Files like `image-hash.js`,
   `gesture.js`, `exporter.js`, `zip.js` export for Node (`module.exports`) *and* attach to the
   browser global. New pure logic must follow this and add cases to `test/run.cjs`.
5. **Keep permissions minimal.** Adding a `permissions` entry changes the install prompt and review
   posture — only add one if the feature truly needs it, and say why in the PR.
6. **Never commit** secrets, `dist/`, `node_modules/`, or other build artifacts (already in
   `.gitignore`). Don't commit recorded sessions or screenshots.
7. **Keep the agent-facing output clean.** `feedback.md` (built in `src/background/exporter.js`) is
   the contract with the downstream AI — keep it readable and stable; update its tests if you change
   the shape.

## Required checks before you commit

Both must pass — treat a failure as a blocker, not a warning:

```bash
npm test       # pure-logic unit tests (must be green)
npm run verify # parses manifest.json, confirms every referenced file exists,
               # and node --check's every .js file (catches syntax errors)
```

If you changed pure logic, add/adjust tests in `test/run.cjs`. If you added a file the manifest or a
page references, make sure `npm run verify` still passes (update `scripts/verify.cjs`'s
code-referenced list if you added a non-manifest page).

## Manual verification (the part tests can't cover)

Most of this extension is browser-bound and **cannot** be proven correct by unit tests alone. After
any non-trivial change you (or the human) must:

1. `chrome://extensions` → reload the unpacked extension (re-accept permissions if prompted).
2. Open a normal http/https tab, start a recording, talk, click/scroll/select, and stop.
3. Confirm: live transcript shows, screenshots are captured + deduped, the overlay works
   (drag/minimize), `feedback.md` + screenshots land in Downloads, and the clipboard prompt is set.
4. Check the **service worker** console (`chrome://extensions` → "service worker") for `[scf]` errors.

State in the PR what you verified manually. **Do not claim a browser behavior works if you only ran
the unit tests** — say it's unverified and needs a human to load it.

## Definition of done for a change

- [ ] `npm test` and `npm run verify` pass.
- [ ] No new runtime dependency / build step; no `import`/`export` in worker or content scripts.
- [ ] New messages/settings go through `protocol.js` / `config.js`.
- [ ] New pure logic has tests.
- [ ] Docs updated if behavior, names, permissions, or the output format changed (README / INSTALL /
      CONTRIBUTING / this file).
- [ ] Manually loaded in Chrome and sanity-checked (or explicitly flagged as needing a human to verify).
- [ ] User-facing change shipping a release? Bump the version with `npm run bump` (keeps
      `manifest.json` + `package.json` in sync) — see **Releasing** below.
- [ ] Focused commits; PR explains **what** and **why**.

## Releasing (maintainers)

Users install via "Load unpacked", so Chrome does **not** auto-update — every user-facing change
should get a version bump and a fresh GitHub release so people can tell what they're running (the
README's install link points at `/releases/latest`).

1. **Bump the version:** `npm run bump` (patch) — or `npm run bump:minor` / `npm run bump:major`, or
   `node scripts/bump.cjs X.Y.Z` for an explicit version. This updates `version` in **both**
   `manifest.json` and `package.json` at once; they must match (`npm run verify` fails if they drift).
2. `npm test && npm run verify && npm run pack` (add `npm run pack:store` if refreshing Web Store assets).
3. Commit the bump, then tag + publish the release with the zip:
   `gh release create vX.Y.Z dist/almost-video-feedback.zip -t "vX.Y.Z" -n "<short notes>"`.

## Quick file map

| Area | Files |
|---|---|
| Orchestration | `src/background/service-worker.js` |
| Capture + dedup | `src/background/capture.js`, `image-hash.js` |
| Loom import | `src/content/loom-import.js` (scrape transcript + drive player), `src/background/loom-capture.js` (seek + `captureVisibleTab` + crop), `src/background/loom-timeline.js` (pure target-time math) |
| Storage (live + history) | `src/background/session-store.js` (IndexedDB) |
| Output | `src/background/exporter.js`, `downloads.js`, `src/common/zip.js` |
| Transcription + overlay + input | `src/content/*` + `src/recognizer/*` (Web Speech in an extension-origin iframe injected into the page; when a page's Permissions-Policy blocks the iframe's mic, the SW falls back to the offscreen doc). `src/background/mic-triage.js` = pure failure triage (tested). |
| On-page drawing (canvas) | `src/content/annotate.js` (`SCF_ANNOTATE`; drawn into the page so it lands in shots). Injected in **all frames** via a 2nd `content_scripts` entry — in sub-frames it self-drives off SW messages (`ANNOTATE_READY`/`SESSION_STARTED`/`CLEAR_ANNOTATIONS`); the top frame is driven by `content.js`. |
| Clipboard + fallback recognition | `src/offscreen/*` (clipboard writes; speech via getUserMedia + `SpeechRecognition.start(track)` when the page blocks the iframe recognizer) |
| UI | `src/popup/*`, `src/options/*`, `src/history/*` |
| Shared | `src/common/protocol.js`, `config.js` |
