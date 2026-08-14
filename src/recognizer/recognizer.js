/*
 * Web Speech transcription, running inside the extension-origin iframe that the
 * content script injects into the page. Because this document is the extension
 * origin, it uses the EXTENSION's microphone permission (granted once, e.g. via
 * the popup), so the user is never prompted per website.
 *
 * Auto-starts on load (the content script only injects it during a live session)
 * and streams results to the service worker, which forwards them to the overlay.
 */
(function () {
  'use strict';
  const MSG = self.SCF.MSG;
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;

  let recognition = null;
  let wantRunning = false;
  let running = false;
  let restartTimer = null;
  let lang = 'en-US';
  try {
    lang = new URLSearchParams(location.search).get('lang') || 'en-US';
  } catch (e) {
    /* ignore */
  }

  // Diagnose up front WHY the mic might fail here, so an error report is
  // actionable instead of a generic "blocked":
  //  - policyAllowed: does the EMBEDDING PAGE's Permissions-Policy delegate the
  //    mic to this frame? (Sites shipping `Permissions-Policy: microphone=()`
  //    block us no matter what the user granted — the SW then falls back to
  //    recognizing in the offscreen document.)
  //  - permState: is the extension origin's own mic permission granted?
  let policyAllowed = null;
  try {
    const pol = document.permissionsPolicy || document.featurePolicy;
    if (pol && typeof pol.allowsFeature === 'function') policyAllowed = pol.allowsFeature('microphone');
  } catch (e) {
    /* leave null (unknown) */
  }
  let permState = null;
  let permQuery = Promise.resolve();
  try {
    permQuery = navigator.permissions
      .query({ name: 'microphone' })
      .then((s) => {
        permState = s.state;
      })
      .catch(() => {});
  } catch (e) {
    /* leave null */
  }

  function post(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {
      /* SW asleep */
    }
  }

  // Attach the diagnosis to every error report; wait briefly for the permission
  // query so the first (often instant) failure still carries permState.
  function postError(error) {
    const timeout = new Promise((r) => setTimeout(r, 250));
    Promise.race([permQuery, timeout]).then(() => {
      post({ type: MSG.TRANSCRIBE_ERROR, error, src: 'iframe', policyAllowed, permState });
    });
  }

  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    r.onstart = () => {
      running = true;
      post({ type: MSG.MIC_LISTENING, src: 'iframe' });
    };
    // fires once the user agent actually starts capturing audio — the truest
    // "we're listening now" signal for the overlay
    r.onaudiostart = () => {
      post({ type: MSG.MIC_LISTENING, src: 'iframe' });
    };
    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0] && res[0].transcript ? res[0].transcript : '';
        if (res.isFinal) {
          const f = text.trim();
          if (f) post({ type: MSG.TRANSCRIPT_SEGMENT, final: true, text: f, t: Date.now(), src: 'iframe' });
        } else {
          interim += text;
        }
      }
      if (interim.trim()) {
        post({ type: MSG.TRANSCRIPT_SEGMENT, final: false, text: interim.trim(), t: Date.now(), src: 'iframe' });
      }
    };
    r.onerror = (event) => {
      const err = event.error || 'unknown';
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') wantRunning = false;
      postError(err);
    };
    r.onend = () => {
      running = false;
      if (wantRunning) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
          if (!wantRunning) return;
          try {
            recognition.start();
          } catch (e) {
            try {
              recognition = build();
              recognition.start();
            } catch (e2) {
              postError('restart-failed');
            }
          }
        }, 250);
      }
    };
    return r;
  }

  function start() {
    if (!SR) {
      postError('speech-recognition-unavailable');
      return;
    }
    // The page has already vetoed mic use in embedded frames — starting would
    // just burn seconds before the same failure. Report immediately so the SW
    // switches to the offscreen recognizer without a visible stall.
    if (policyAllowed === false) {
      postError('not-allowed');
      return;
    }
    wantRunning = true;
    if (running) return;
    if (!recognition) recognition = build();
    recognition.lang = lang;
    try {
      recognition.start();
    } catch (e) {
      /* throws if called while starting */
    }
  }

  function stop() {
    wantRunning = false;
    clearTimeout(restartTimer);
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        /* ignore */
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.RECOGNIZER_STOP) stop();
  });

  start();
})();
