/*
 * Orchestrator service worker (classic; loads helpers via importScripts).
 *
 * Owns the session state machine, routes messages between popup / content /
 * offscreen, drives navigation + heartbeat captures, the hotkeys, the toolbar
 * badge, and the final export + clipboard hand-off.
 */
importScripts(
  '../common/protocol.js',
  '../common/config.js',
  'image-hash.js',
  'mic-triage.js',
  'session-store.js',
  'exporter.js',
  'loom-timeline.js',
  'capture.js',
  'downloads.js',
  'loom-capture.js'
);

const { MSG, TRIGGER } = self.SCF;
const store = self.SCF.sessionStore;
const capture = self.SCF.capture;

// In-memory session (mirrors the durable meta in IndexedDB).
let session = null; // { active, startedAt, startedAtText, tabId, windowId, settings }
let lastResult = null;
let creatingOffscreen = null;
// Stays true through the post-stop flush window so the final spoken segment
// (which arrives a few hundred ms after we stop recognition) is still recorded.
let transcriptOpen = false;
// Running transcript (finalized segments) for the session, so a freshly-armed
// overlay — e.g. after following focus to another window — shows what's been
// heard so far instead of looking like it lost everything.
let transcriptText = '';
let stopping = false; // true while a stop is saving/exporting (popup shows "Saving…")
let starting = false; // true between a start request and session becoming active (debounces icon double-clicks)
let recoverPromise = null; // resolves once mid-session state has been restored
const inkFrames = new Set(); // frameIds (this tab) that currently have a drawing

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- utilities

function capturable(url) {
  if (!url) return false;
  return !/^(chrome|edge|about|view-source|chrome-extension|devtools|moz-extension):/i.test(url) &&
    !/^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
}

// A loom.com/share/... page — the one place where clicking the toolbar icon should
// open the popup (Start recording vs. Import this Loom video) instead of auto-recording.
function isLoomShareUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)loom\.com$/i.test(u.hostname) && /\/share\//.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function setBadge(mode) {
  if (mode === 'recording') {
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#e11d48' });
    chrome.action.setTitle({ title: 'Recording feedback — click to stop' });
  } else if (mode === 'paused') {
    chrome.action.setBadgeText({ text: '❚❚' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    chrome.action.setTitle({ title: 'Recording paused — click to stop' });
  } else if (mode === 'saving') {
    chrome.action.setBadgeText({ text: '…' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
    chrome.action.setTitle({ title: 'Saving feedback…' });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Almost Video Feedback' });
  }
}

function notifyContent(tabId, msg) {
  if (tabId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
  } catch (e) {
    /* no receiver */
  }
}

// Send to one specific frame in a tab (e.g. re-arm a single late-loading iframe).
function notifyFrame(tabId, frameId, msg) {
  if (tabId == null || frameId == null) return;
  try {
    chrome.tabs.sendMessage(tabId, msg, { frameId }, () => void chrome.runtime.lastError);
  } catch (e) {
    /* no receiver */
  }
}

function broadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch (e) {
    /* no receiver */
  }
}

async function sendToOffscreen(msg) {
  try {
    return await chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
  } catch (e) {
    return null; // offscreen not present
  }
}

function statePayload() {
  return {
    recording: !!(session && session.active),
    paused: !!(session && session.paused),
    saving: stopping,
    startedAt: session ? session.startedAt : null,
    screenshots: capture.getSeq(),
    tabId: session ? session.tabId : null,
    lastResult,
  };
}

function openPopup() {
  try {
    if (chrome.action.openPopup) chrome.action.openPopup().catch(() => {});
  } catch (e) {
    /* not available / no focused window */
  }
}

// Click-to-record: when the setting is on and we're idle, clear the action popup
// so a click fires chrome.action.onClicked (which starts recording immediately).
// While recording (or when the setting is off) the popup is restored, so a click
// opens it as usual. Exception: on a Loom share page we always keep the popup so the
// click offers a choice (Start recording vs. Import this Loom video) — auto-recording
// there would force the user to record-then-discard before they could import.
async function applyActionMode() {
  let clickStarts = true;
  try {
    const s = await self.SCF_CONFIG.load();
    clickStarts = s.clickStartsRecording !== false;
  } catch (e) {
    /* default true */
  }
  const recording = !!(session && session.active) || importing;
  let onLoom = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    onLoom = !!(tab && isLoomShareUrl(tab.url));
  } catch (e) {
    /* ignore — treat as not-Loom */
  }
  const popup = clickStarts && !recording && !onLoom ? '' : 'src/popup/popup.html';
  try {
    await chrome.action.setPopup({ popup });
  } catch (e) {
    /* ignore */
  }
}

function broadcastStatus() {
  broadcast({ type: MSG.STATUS, state: statePayload() });
}

// --------------------------------------------------------------- offscreen

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctxs.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['CLIPBOARD', 'USER_MEDIA'],
      justification:
        'Copy the feedback file path to the clipboard when a recording is saved, and run mic ' +
        'transcription when the recorded page blocks microphone use for embedded frames.',
    })
    .catch((e) => {
      // someone else created it in the meantime — that's fine
      if (!/single offscreen/i.test(e.message || '')) console.warn('[scf] offscreen create:', e.message);
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      /* already closed */
    }
  }
}

// Inject the content script for tabs that were already open before the extension
// loaded (manifest injection only covers tabs navigated after install). The
// content files guard against double-initialization, so this is idempotent.
// The file list comes straight from the manifest so the two can never drift.
function contentScriptFiles() {
  const cs = (chrome.runtime.getManifest().content_scripts || [])[0];
  return (cs && cs.js) || [];
}
async function ensureContentScript(tabId) {
  const files = contentScriptFiles();
  if (!files.length) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (e) {
    /* restricted page or already present */
  }
}

// ------------------------------------------------------------ session flow

async function startRecording(requestedTabId) {
  if (importing || starting || (session && session.active)) return statePayload();
  starting = true;

  let tab;
  if (requestedTabId != null) {
    tab = await chrome.tabs.get(requestedTabId).catch(() => null);
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  }
  if (!tab || !capturable(tab.url)) {
    starting = false;
    broadcast({ type: MSG.STATUS, state: statePayload(), error: 'This page can\'t be recorded (try a normal http/https tab).' });
    return statePayload();
  }

  const settings = await self.SCF_CONFIG.load();
  await store.reset();
  const startedAt = Date.now();
  const startedAtText = new Date(startedAt).toLocaleString();

  session = {
    active: true,
    startedAt,
    startedAtText,
    tabId: tab.id,
    windowId: tab.windowId,
    settings,
    // where speech recognition runs: the extension iframe in the page, or the
    // offscreen document once a page's Permissions-Policy blocks the iframe mic
    recMode: 'iframe',
    recFallbackTried: false,
  };
  starting = false; // session.active now guards re-entry; don't leave this stuck if a later await throws
  await store.setMeta({
    active: true,
    startedAt,
    startedAtText,
    tabId: tab.id,
    windowId: tab.windowId,
    lastUrl: tab.url,
    lastTitle: tab.title,
  });

  capture.begin({ windowId: tab.windowId, tabId: tab.id, settings, lastUrl: tab.url, lastTitle: tab.title, startedAt });
  capture.hooks.onKept = () => broadcastStatus();
  transcriptOpen = true;
  transcriptText = '';
  inkFrames.clear();

  // Screenshots are written to Downloads during the recording (so stop is fast);
  // hide the download shelf for the whole session so it doesn't pop up repeatedly.
  self.SCF.downloads.setDownloadUi(false);

  setBadge('recording');
  applyActionMode(); // recording -> icon click opens the popup (which stops)
  ensureOffscreen(); // pre-warm the clipboard doc so the save is instant (no await)

  if (settings.triggers.heartbeat) {
    chrome.alarms.create('heartbeat', { periodInMinutes: Math.max(0.5, settings.heartbeatSeconds / 60) });
  }

  // Arm the (usually already-injected) content script immediately so the overlay
  // appears instantly; inject in the background for tabs that predate the
  // extension (their CONTENT_READY re-arms them). Don't block start on injection.
  notifyContent(tab.id, { type: MSG.SESSION_STARTED, settings, startedAt, transcript: transcriptText, recMode: 'iframe' });
  ensureContentScript(tab.id);

  if (settings.triggers.start) {
    capture.request(TRIGGER.START, { url: tab.url, title: tab.title });
  }

  broadcastStatus();
  return statePayload();
}

// Shared finalize: build the bundle, write it, copy the clipboard prompt, archive
// the session, and set lastResult. Used by both stopRecording and importLoom.
async function exportAndArchive(events, meta, endedAt) {
  const bundle = self.SCF.exporter.build(events, meta);
  let written = { mdPath: null, folderPath: null, dir: null };
  try {
    written = await self.SCF.downloads.writeSession(bundle, meta.startedAt);
  } catch (e) {
    console.warn('[scf] export failed:', e && e.message);
  }
  setTimeout(() => self.SCF.downloads.setDownloadUi(true), 1500);

  const clip = self.SCF.downloads.clipboardText(written.mdPath, written.dir);
  await ensureOffscreen();
  await sendToOffscreen({ type: MSG.COPY_TO_CLIPBOARD, text: clip });

  const transcriptCount = events.filter((e) => e.type === 'transcript' && e.final).length;

  try {
    const shots = [];
    for (const s of bundle.screenshots) {
      const shot = await store.getScreenshot(s.seq);
      if (shot && shot.blob) shots.push({ seq: s.seq, blob: shot.blob, mime: shot.mime });
    }
    const pages = [];
    const seenPages = new Set();
    for (const e of events) {
      if (e.url && !seenPages.has(e.url)) { seenPages.add(e.url); pages.push({ url: e.url, title: e.title || '' }); }
    }
    await store.archiveSession(
      {
        id: String(meta.startedAt), startedAt: meta.startedAt, endedAt,
        startedAtText: meta.startedAtText, durationMs: endedAt - meta.startedAt,
        pages, screenshotCount: bundle.screenshots.length, transcriptCount,
        mdPath: written.mdPath, folderPath: written.folderPath, dir: written.dir, events,
      },
      shots
    );
  } catch (e) {
    console.warn('[scf] archive failed:', e && e.message);
  }

  lastResult = {
    id: String(meta.startedAt), mdPath: written.mdPath, folderPath: written.folderPath, dir: written.dir,
    clip, screenshots: bundle.screenshots.length, transcriptSegments: transcriptCount, at: endedAt,
  };
  await chrome.storage.local.set({ lastResult });
  return lastResult;
}

async function stopRecording(opts) {
  if (!session || !session.active) return lastResult || statePayload();
  const openMenu = !opts || opts.openMenu !== false;

  const s = session;
  s.active = false;
  stopping = true;
  setBadge('saving');
  // pop the menu open so the user sees it saving + the result + recent list
  // (skip when the stop came from the already-open popup)
  if (openMenu) openPopup();
  broadcastStatus();
  chrome.alarms.clear('heartbeat');
  capture.end();

  // Ask the recognizer (page iframe or offscreen fallback — both obey this) to
  // flush its final segment (transcriptOpen keeps handleTranscript writing it),
  // then tear down the overlay + iframe.
  broadcast({ type: MSG.RECOGNIZER_STOP });
  await delay(500);
  transcriptOpen = false;
  notifyContent(s.tabId, { type: MSG.SESSION_STOPPED });

  const endedAt = Date.now();
  await store.patchMeta({ active: false, endedAt });

  // build + write the bundle (shared with the Loom import path)
  const events = await store.getEvents();
  const meta = await store.getMeta();
  await exportAndArchive(events, meta, endedAt);

  await closeOffscreen();
  setBadge('idle');
  session = null;
  stopping = false;
  inkFrames.clear();
  applyActionMode(); // idle -> clicking the icon starts the next recording

  // in-page toast so the user knows it's ready even if the popup didn't open /
  // the extension isn't pinned
  notifyContent(s.tabId, { type: MSG.SAVED_NOTICE });

  broadcastStatus();
  broadcast({ type: 'export_done', result: lastResult });
  return lastResult;
}

// Discard a recording: remove it from the library (IndexedDB) and best-effort
// delete the files it wrote to the Downloads folder.
async function discardRecording(id) {
  if (!id) return false;
  let rec = null;
  try {
    rec = await store.getHistory(id);
  } catch (e) {
    /* ignore */
  }
  try {
    await store.deleteHistory(id); // removes the record + its archived screenshots
  } catch (e) {
    /* ignore */
  }
  await deleteDownloadedFiles(rec && (rec.dir || rec.folderPath));
  if (lastResult && lastResult.id === id) {
    lastResult = null;
    try {
      await chrome.storage.local.set({ lastResult: null });
    } catch (e) {
      /* ignore */
    }
    broadcastStatus();
  }
  return true;
}

// Delete the screenshots + feedback.md/json this session wrote to Downloads.
async function deleteDownloadedFiles(dir) {
  if (!dir) return;
  const seg = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop(); // session-YYYYMMDD-HHMMSS
  if (!seg) return;
  let items = [];
  try {
    items = await chrome.downloads.search({ query: [seg] });
  } catch (e) {
    return;
  }
  for (const it of items || []) {
    if (!it || !it.filename || it.filename.replace(/\\/g, '/').indexOf(seg) === -1) continue;
    try {
      await chrome.downloads.removeFile(it.id); // delete the file from disk
    } catch (e) {
      /* already moved/deleted */
    }
    try {
      await chrome.downloads.erase({ id: it.id }); // drop it from the downloads list
    } catch (e) {
      /* ignore */
    }
  }
}

let importing = false;

async function importLoom(requestedTabId) {
  if (importing || (session && session.active)) return { error: 'busy' };
  let tab = requestedTabId != null
    ? await chrome.tabs.get(requestedTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab || !isLoomShareUrl(tab.url)) {
    return { error: 'not-a-loom-page' };
  }

  importing = true;
  setBadge('saving');
  const settings = await self.SCF_CONFIG.load();
  await store.reset();
  const startedAt = Date.now();
  const startedAtText = new Date(startedAt).toLocaleString();
  const dir = self.SCF.downloads.sessionDir(startedAt);
  self.SCF.downloads.setDownloadUi(false);
  await store.setMeta({ active: false, startedAt, startedAtText, tabId: tab.id, windowId: tab.windowId, lastUrl: tab.url, lastTitle: tab.title });

  await ensureContentScript(tab.id); // make sure loom-import.js is present
  let res;
  try {
    res = await self.SCF.loomCapture.runImport({
      tabId: tab.id, windowId: tab.windowId, startedAt, settings, dir, store,
      onProgress: (p) => broadcast({ type: MSG.IMPORT_PROGRESS, progress: p }),
    });
  } catch (e) {
    res = { error: (e && e.message) || 'import-failed' };
  }

  if (res && res.error) {
    importing = false;
    setBadge('idle');
    applyActionMode();
    self.SCF.downloads.setDownloadUi(true);
    const human = res.error === 'no-transcript'
      ? 'This Loom video has no transcript to import.'
      : 'Couldn\'t import this Loom video (' + res.error + '). Keep the Loom tab visible and try again.';
    broadcast({ type: MSG.STATUS, state: statePayload(), error: human });
    return { error: res.error };
  }

  const endedAt = startedAt + (res.lastMs || 0);
  await store.patchMeta({ active: false, endedAt });
  const events = await store.getEvents();
  const meta = await store.getMeta();
  await exportAndArchive(events, meta, Math.max(endedAt, meta.startedAt + 1000));
  await closeOffscreen();

  importing = false;
  setBadge('idle');
  applyActionMode(); // still on the Loom tab -> keep the popup (not auto-record)
  broadcastStatus();
  broadcast({ type: 'export_done', result: lastResult });
  return lastResult;
}

async function toggleRecording() {
  if (session && session.active) return stopRecording();
  return startRecording();
}

// Pause/resume: keep the session alive but stop the mic + screenshot capture, so
// nothing is recorded until the user resumes. The recognizer (mic) is torn down by
// the content script on SESSION_PAUSED and restarted on SESSION_RESUMED.
function togglePause() {
  if (!session || !session.active) return statePayload();
  session.paused = !session.paused;
  capture.setPaused(session.paused);
  store.patchMeta({ paused: session.paused }).catch(() => {});
  if (session.paused) {
    chrome.alarms.clear('heartbeat');
    setBadge('paused');
    notifyContent(session.tabId, { type: MSG.SESSION_PAUSED });
    // the content script tears down its iframe recognizer; the offscreen
    // fallback (if engaged) is stopped by the same broadcast every host obeys
    broadcast({ type: MSG.RECOGNIZER_STOP });
  } else {
    const s = session.settings || {};
    if (s.triggers && s.triggers.heartbeat) {
      chrome.alarms.create('heartbeat', { periodInMinutes: Math.max(0.5, s.heartbeatSeconds / 60) });
    }
    setBadge('recording');
    notifyContent(session.tabId, { type: MSG.SESSION_RESUMED, recMode: session.recMode || 'iframe' });
    if (session.recMode === 'offscreen') {
      ensureOffscreen().then(() => {
        broadcast({
          type: MSG.OFFSCREEN_RECOGNIZE,
          lang: (session && session.settings && session.settings.language) || 'en-US',
        });
      });
    }
  }
  broadcastStatus();
  return statePayload();
}

// ------------------------------------------------------------- nav + alarms

chrome.webNavigation.onCompleted.addListener((d) => {
  if (!session || !session.active) return;
  if (d.tabId !== session.tabId || d.frameId !== 0) return;
  capture.setContext({ lastUrl: d.url });
  store.patchMeta({ lastUrl: d.url }).catch(() => {});
  setTimeout(() => {
    chrome.tabs.get(session.tabId, (tab) => {
      const title = tab && tab.title;
      if (title) {
        capture.setContext({ lastTitle: title });
        store.patchMeta({ lastTitle: title }).catch(() => {});
      }
      store.addEvent({ t: Date.now(), type: 'navigation', url: d.url, title: title || null });
      capture.request(TRIGGER.NAVIGATION, { url: d.url, title: title || null });
    });
  }, (session.settings && session.settings.navSettleMs) || 500);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat' && session && session.active) {
    capture.request(TRIGGER.HEARTBEAT, {});
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') toggleRecording();
  else if (command === 'force-screenshot' && session && session.active) {
    capture.request(TRIGGER.FORCED, {});
  }
});

// ------------------------------------------------------ follow focus
// During a session, move the recording (overlay, input tracking, recognizer,
// captures) to whatever tab/window the user focuses, so reviewing a multi-tab
// flow is captured continuously.
let followTimer = null;
function scheduleFollowFocus() {
  if (!session || !session.active) return;
  clearTimeout(followTimer);
  followTimer = setTimeout(followFocus, 250);
}

async function followFocus() {
  if (!session || !session.active || session.paused) return; // stay put while paused
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs[0];
  } catch (e) {
    return;
  }
  if (!tab || tab.id === session.tabId) return; // already recording this tab
  if (!capturable(tab.url)) return; // ignore chrome:// etc. — keep the previous tab

  const oldTabId = session.tabId;
  session.tabId = tab.id;
  session.windowId = tab.windowId;
  capture.setContext({ tabId: tab.id, windowId: tab.windowId, lastUrl: tab.url, lastTitle: tab.title });
  store.patchMeta({ tabId: tab.id, windowId: tab.windowId, lastUrl: tab.url, lastTitle: tab.title }).catch(() => {});

  // tear down the overlay/recognizer on the old tab, arm the newly-focused one
  notifyContent(oldTabId, { type: MSG.SESSION_STOPPED });
  await ensureContentScript(tab.id);
  notifyContent(tab.id, {
    type: MSG.SESSION_STARTED,
    settings: session.settings,
    startedAt: session.startedAt,
    transcript: transcriptText, // so the new window's overlay shows what we've heard
    recMode: session.recMode || 'iframe', // offscreen recognition keeps running across tab moves
  });

  // capture the newly-focused view + record the page change
  store.addEvent({ t: Date.now(), type: 'navigation', url: tab.url, title: tab.title || null });
  capture.request(TRIGGER.NAVIGATION, { url: tab.url, title: tab.title || null });
}

chrome.tabs.onActivated.addListener(() => {
  scheduleFollowFocus();
  applyActionMode(); // a Loom share tab forces the popup; others fall back to click-to-record
});
chrome.windows.onFocusChanged.addListener((winId) => {
  if (winId !== chrome.windows.WINDOW_ID_NONE) {
    scheduleFollowFocus();
    applyActionMode();
  }
});
// the focused tab navigating into/out of a loom.com/share URL also changes the action mode
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab && tab.active) applyActionMode();
});

// click-to-record: only fires when the popup is empty (fast mode + idle)
chrome.action.onClicked.addListener(async () => {
  if (recoverPromise) await recoverPromise;
  if (!(session && session.active)) startRecording();
});

// re-apply the action mode when the setting changes from the options page
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) applyActionMode();
});

// --------------------------------------------------------------- messaging

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case MSG.GET_STATE:
      (async () => {
        if (recoverPromise) await recoverPromise; // accurate state after a SW restart
        if (!lastResult) {
          const got = await chrome.storage.local.get('lastResult');
          lastResult = got.lastResult || null;
        }
        sendResponse(statePayload());
      })();
      return true;

    case MSG.START_RECORDING:
      (async () => {
        if (recoverPromise) await recoverPromise;
        // only first-party extension pages (no sender.tab) may target a tab id;
        // a content script can't ask the SW to record an arbitrary tab
        const reqTab = sender && sender.tab ? undefined : msg.tabId;
        sendResponse(await startRecording(reqTab));
      })();
      return true;

    case MSG.IMPORT_LOOM:
      (async () => {
        if (recoverPromise) await recoverPromise;
        const reqTab = sender && sender.tab ? undefined : msg.tabId;
        sendResponse(await importLoom(reqTab));
      })();
      return true;

    case MSG.STOP_RECORDING:
      // open the menu only when the stop came from the page overlay (not the
      // already-open popup, which has no sender.tab)
      (async () => {
        if (recoverPromise) await recoverPromise;
        sendResponse(await stopRecording({ openMenu: !!(sender && sender.tab) }));
      })();
      return true;

    case MSG.COPY_LAST:
      (async () => {
        if (!lastResult) {
          const got = await chrome.storage.local.get('lastResult');
          lastResult = got.lastResult || null;
        }
        if (lastResult && lastResult.clip) {
          await ensureOffscreen();
          await sendToOffscreen({ type: MSG.COPY_TO_CLIPBOARD, text: lastResult.clip });
          if (!(session && session.active)) await closeOffscreen();
        }
        sendResponse(lastResult);
      })();
      return true;

    case MSG.FORCE_SHOT:
      if (session && session.active) capture.request(TRIGGER.FORCED, {});
      return false;

    case MSG.TOGGLE_PAUSE:
      sendResponse(togglePause());
      return false;

    case MSG.DELETE_RECORDING:
      (async () => {
        const ok = await discardRecording(msg.id);
        sendResponse({ ok });
      })();
      return true;

    // ---- from content scripts ----
    case MSG.CONTENT_READY:
      if (session && session.active && sender.tab && sender.tab.id === session.tabId) {
        notifyContent(session.tabId, {
          type: MSG.SESSION_STARTED,
          settings: session.settings,
          startedAt: session.startedAt,
          transcript: transcriptText,
          paused: !!session.paused,
          recMode: session.recMode || 'iframe',
        });
      }
      return false;

    case MSG.REQUEST_CAPTURE:
      if (session && session.active && sender.tab && sender.tab.id === session.tabId) {
        capture.request(msg.trigger, msg.meta || {});
      }
      return false;

    // ---- drawing across frames ----
    case MSG.ANNOTATE_READY:
      // a drawing-capable (sub)frame loaded; if a session is live, tell just that
      // frame to start (targeted so it doesn't reset the top frame's state)
      if (session && session.active && sender.tab && sender.tab.id === session.tabId && sender.frameId) {
        notifyFrame(session.tabId, sender.frameId, {
          type: MSG.SESSION_STARTED,
          settings: session.settings,
          startedAt: session.startedAt,
        });
      }
      return false;

    case MSG.ANNOTATE_INK:
      if (session && session.active && sender.tab && sender.tab.id === session.tabId) {
        const fid = sender.frameId || 0;
        if (msg.hasInk) inkFrames.add(fid);
        else inkFrames.delete(fid);
        notifyContent(session.tabId, { type: MSG.ANNOTATE_INK_ANY, any: inkFrames.size > 0 });
      }
      return false;

    case MSG.CLEAR_ANNOTATIONS:
      if (session && session.active && sender.tab && sender.tab.id === session.tabId) {
        inkFrames.clear();
        notifyContent(session.tabId, { type: MSG.CLEAR_ANNOTATIONS }); // every frame clears
        notifyContent(session.tabId, { type: MSG.ANNOTATE_INK_ANY, any: false });
      }
      return false;

    case MSG.PAGE_INFO:
    case MSG.ROUTE_CHANGED:
      if (session && session.active && sender.tab && sender.tab.id === session.tabId) {
        capture.setContext({ lastUrl: msg.url, lastTitle: msg.title });
        store.patchMeta({ lastUrl: msg.url, lastTitle: msg.title }).catch(() => {});
        if (msg.type === MSG.ROUTE_CHANGED) {
          store.addEvent({ t: Date.now(), type: 'navigation', url: msg.url, title: msg.title || null });
        }
      }
      return false;

    // ---- transcription (recognizer iframe, or the offscreen fallback) ----
    case MSG.TRANSCRIPT_SEGMENT:
      // gate on transcriptOpen (not session.active) so the final segment that
      // flushes in during the post-stop window is still recorded
      if (transcriptOpen && fromCurrentRecognizer(msg, sender)) {
        handleTranscript(msg);
      }
      return false;

    case MSG.MIC_LISTENING:
      // recognition is actually capturing audio -> tell the overlay to switch
      // from "starting microphone…" to the live recording UI
      if (session && session.active && fromCurrentRecognizer(msg, sender)) {
        notifyContent(session.tabId, { type: MSG.MIC_LISTENING });
      }
      return false;

    // ---- from offscreen ----
    case MSG.OFFSCREEN_READY:
      return false;

    case MSG.TRANSCRIBE_ERROR:
      handleTranscribeError(msg);
      return false;

    case MSG.KEEPALIVE:
      return false;

    default:
      return false;
  }
});

// Accept recognizer traffic only from wherever recognition currently runs — the
// extension iframe in the recorded tab, or the offscreen document after a
// fallback — so the switchover can't double transcripts.
function fromCurrentRecognizer(msg, sender) {
  if (!session) return false;
  if ((session.recMode || 'iframe') === 'offscreen') {
    return msg.src === 'offscreen' && !!sender && !sender.tab;
  }
  return !!(sender && sender.tab && sender.tab.id === session.tabId && msg.src !== 'offscreen');
}

function handleTranscript(msg) {
  // store finalized segments through the post-stop flush window, and forward
  // everything to the overlay.
  const t = msg.t || Date.now();
  if (msg.final && transcriptOpen) {
    store.addEvent({ t, type: 'transcript', final: true, text: msg.text });
    transcriptText += (transcriptText ? ' ' : '') + msg.text;
  }
  if (session && session.active) {
    notifyContent(session.tabId, { type: MSG.TRANSCRIPT_UPDATE, final: !!msg.final, text: msg.text });
  }
}

// Popup banner text per triage verdict (the overlay has its own phrasing).
const MIC_ERROR_STATUS = {
  permission:
    'Microphone permission needed — click the extension icon and allow the mic (choose "Allow on every visit"), then restart recording.',
  'page-blocked': 'This site blocks microphone use for extensions — recording continues without a transcript.',
  service: "Chrome's speech service isn't responding — recording continues without a transcript.",
  'no-audio': 'No working microphone found — recording continues without a transcript.',
  blocked: 'Microphone was blocked. Allow it for the extension (toolbar popup), then restart recording.',
};

function handleTranscribeError(msg) {
  const err = (msg.error || '').toLowerCase();
  console.warn(
    '[scf] transcribe error:', msg.error,
    '· src:', msg.src || 'iframe',
    '· pagePolicyAllowsMic:', msg.policyAllowed,
    '· extensionMicPermission:', msg.permState
  );
  if (!(session && session.active)) return;
  const verdict = self.SCF.micTriage.classify({
    error: err,
    src: msg.src,
    policyAllowed: msg.policyAllowed,
    permState: msg.permState,
  });
  if (verdict.kind === 'other') return; // transient; the recognizer's own restart loop handles it

  // Once the offscreen fallback is engaged, late errors from the abandoned page
  // iframe are noise — don't let them override the fallback's outcome.
  if ((msg.src || 'iframe') !== 'offscreen' && session.recMode === 'offscreen') return;

  // First blocked verdict from the page iframe: retry in the offscreen document,
  // which no page Permissions-Policy can reach. The overlay stays on "starting
  // microphone…" until the fallback reports MIC_LISTENING (or fails, below).
  if (verdict.fallback && !session.recFallbackTried) {
    session.recFallbackTried = true;
    session.recMode = 'offscreen';
    session.recFallbackReason = verdict.kind;
    store.patchMeta({ recMode: 'offscreen', recFallbackTried: true, recFallbackReason: verdict.kind }).catch(() => {});
    console.warn('[scf] page recognizer blocked (' + verdict.kind + ') — falling back to offscreen recognition');
    ensureOffscreen().then(() => {
      broadcast({
        type: MSG.OFFSCREEN_RECOGNIZE,
        lang: (session && session.settings && session.settings.language) || 'en-US',
      });
    });
    return;
  }

  // Giving up — tell the user the actual cause. When the fallback failed after a
  // page-policy block, the page block is still the story, unless the fallback
  // discovered the real problem is the permission grant itself.
  let kind = verdict.kind;
  if (msg.src === 'offscreen' && kind !== 'permission' && session.recFallbackReason === 'page-blocked') {
    kind = 'page-blocked';
  }
  notifyContent(session.tabId, { type: MSG.TRANSCRIPT_UPDATE, micError: true, micErrorKind: kind });
  broadcast({ type: MSG.STATUS, state: statePayload(), error: MIC_ERROR_STATUS[kind] || MIC_ERROR_STATUS.blocked });
}

// ---- keepalive port from offscreen keeps the SW alive during long silences ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => void chrome.runtime.lastError);
  }
});

// ------------------------------------------------------------- recovery

async function recover() {
  try {
    const meta = await store.getMeta();
    if (meta && meta.active) {
      const settings = await self.SCF_CONFIG.load();
      session = {
        active: true,
        startedAt: meta.startedAt,
        startedAtText: meta.startedAtText,
        tabId: meta.tabId,
        windowId: meta.windowId,
        settings,
        paused: !!meta.paused,
        recMode: meta.recMode || 'iframe',
        recFallbackTried: !!meta.recFallbackTried,
        recFallbackReason: meta.recFallbackReason || null,
      };
      capture.restore(
        { windowId: meta.windowId, tabId: meta.tabId, settings, lastUrl: meta.lastUrl, lastTitle: meta.lastTitle, startedAt: meta.startedAt },
        meta.lastSeq || 0,
        meta.lastKeptHash || null
      );
      capture.hooks.onKept = () => broadcastStatus();
      transcriptOpen = true;
      // rebuild the running transcript from stored finals so a re-armed overlay
      // after this restart still shows what was already heard
      try {
        const evs = await store.getEvents();
        transcriptText = (evs || [])
          .filter((e) => e.type === 'transcript' && e.final && e.text)
          .map((e) => e.text)
          .join(' ');
      } catch (e) {
        /* ignore */
      }
      self.SCF.downloads.setDownloadUi(false);
      if (session.paused) {
        capture.setPaused(true);
        setBadge('paused');
        // leave the heartbeat alarm cleared while paused
      } else {
        setBadge('recording');
        if (settings.triggers.heartbeat) {
          chrome.alarms.create('heartbeat', { periodInMinutes: Math.max(0.5, settings.heartbeatSeconds / 60) });
        }
      }
      // The content script (iframe mode) kept its recognition going across the
      // SW restart. In offscreen mode the doc usually survived too, but a full
      // browser restart loses it — re-arm it; the offscreen recognizer ignores
      // the message if it's already running.
      if (!session.paused && session.recMode === 'offscreen') {
        ensureOffscreen().then(() => {
          broadcast({ type: MSG.OFFSCREEN_RECOGNIZE, lang: settings.language || 'en-US' });
        });
      }
    } else {
      // no active session — make sure the download shelf isn't left suppressed
      // from a prior recording that was abandoned without a clean stop
      self.SCF.downloads.setDownloadUi(true);
    }
  } catch (e) {
    console.warn('[scf] recover failed:', e && e.message);
  }
}

chrome.runtime.onStartup.addListener(() => {
  recoverPromise = recover();
  recoverPromise.then(applyActionMode);
});
chrome.runtime.onInstalled.addListener(() => {
  setBadge('idle');
  applyActionMode();
});
recoverPromise = recover();
recoverPromise.then(applyActionMode);
