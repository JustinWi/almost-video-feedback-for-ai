/*
 * Shared message protocol + small constants.
 * Loaded as a classic script in every context (service worker via importScripts,
 * content script via the content_scripts list, and pages via <script>).
 * Attaches a single namespace to globalThis so all realms agree on the strings.
 */
(function (root) {
  'use strict';

  const MSG = {
    // content -> service worker
    CONTENT_READY: 'content_ready',
    REQUEST_CAPTURE: 'request_capture',
    PAGE_INFO: 'page_info',
    ROUTE_CHANGED: 'route_changed',
    PREPARE_CAPTURE_ACK: 'prepare_capture_ack',

    // service worker -> content
    SESSION_STARTED: 'session_started',
    SESSION_STOPPED: 'session_stopped',
    SESSION_PAUSED: 'session_paused',
    SESSION_RESUMED: 'session_resumed',
    SAVED_NOTICE: 'saved_notice',
    PREPARE_CAPTURE: 'prepare_capture',
    CAPTURE_DONE: 'capture_done',
    TRANSCRIPT_UPDATE: 'transcript_update',
    SCREENSHOT_TOAST: 'screenshot_toast',
    STATUS: 'status',

    // popup/options <-> service worker
    GET_STATE: 'get_state',
    START_RECORDING: 'start_recording',
    STOP_RECORDING: 'stop_recording',
    COPY_LAST: 'copy_last',
    CHECK_MIC: 'check_mic',
    OPEN_PERMISSION: 'open_permission',
    FORCE_SHOT: 'force_shot',
    TOGGLE_PAUSE: 'toggle_pause',
    DELETE_RECORDING: 'delete_recording',

    // service worker <-> offscreen
    OFFSCREEN_READY: 'offscreen_ready',
    OFFSCREEN_START: 'offscreen_start',
    OFFSCREEN_STOP: 'offscreen_stop',

    // drawing across frames (the top frame + any same-tab iframes)
    ANNOTATE_READY: 'annotate_ready', // a drawing-capable (sub)frame asks if a session is live
    ANNOTATE_INK: 'annotate_ink', // a frame reports whether it currently has a drawing
    ANNOTATE_INK_ANY: 'annotate_ink_any', // SW -> top frame: does any frame have a drawing
    CLEAR_ANNOTATIONS: 'clear_annotations', // clear drawings in every frame

    // service worker <-> recognizer (page iframe, or the offscreen fallback)
    RECOGNIZER_STOP: 'recognizer_stop',
    TRANSCRIPT_SEGMENT: 'transcript_segment',
    TRANSCRIBE_ERROR: 'transcribe_error',
    MIC_LISTENING: 'mic_listening', // recognizer is actually capturing audio now
    // SW -> offscreen: run recognition there when the page blocks the iframe's mic
    OFFSCREEN_RECOGNIZE: 'offscreen_recognize',
    COPY_TO_CLIPBOARD: 'copy_to_clipboard',
    KEEPALIVE: 'keepalive',

    // popup -> service worker: import a Loom share video into a bundle
    IMPORT_LOOM: 'import_loom',
    // service worker <-> content (Loom page): scrape transcript / seek player
    LOOM_PROBE: 'loom_probe',
    LOOM_SEEK: 'loom_seek',
    // service worker -> popup: import progress ticks
    IMPORT_PROGRESS: 'import_progress',
  };

  // Screenshot trigger types. Priority triggers bypass the dedup cull.
  const TRIGGER = {
    START: 'start',
    NAVIGATION: 'navigation',
    ROUTE: 'route',
    CLICK: 'click',
    SELECTION: 'selection',
    CIRCLE: 'circle',
    DWELL: 'dwell',
    SCROLL: 'scroll',
    HEARTBEAT: 'heartbeat',
    FORCED: 'forced',
    ANNOTATE: 'annotate',
    FRAME: 'frame', // a frame grabbed from an imported video (Loom import)
  };

  // Priority triggers bypass the dedup cull: deliberate, high-intent actions the
  // user expects to capture. A click is intentional and often produces a small UI
  // change the coarse 9x8 dedup hash can't see, so it must never be culled.
  // (Ambient triggers — dwell/scroll/heartbeat — stay cullable to avoid spam.)
  const PRIORITY_TRIGGERS = new Set([
    TRIGGER.START,
    TRIGGER.NAVIGATION,
    TRIGGER.ROUTE,
    TRIGGER.CLICK,
    TRIGGER.SELECTION,
    TRIGGER.CIRCLE,
    TRIGGER.FORCED,
    TRIGGER.ANNOTATE,
  ]);

  // Merge into the shared namespace without clobbering modules that may have
  // attached first (robust to importScripts/<script> load order).
  root.SCF = root.SCF || {};
  root.SCF.MSG = root.SCF.MSG || MSG;
  root.SCF.TRIGGER = root.SCF.TRIGGER || TRIGGER;
  root.SCF.PRIORITY_TRIGGERS = root.SCF.PRIORITY_TRIGGERS || PRIORITY_TRIGGERS;

  // Dual-export for Node unit tests (see test/run.cjs).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MSG, TRIGGER, PRIORITY_TRIGGERS };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
