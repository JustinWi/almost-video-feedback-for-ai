/*
 * Offscreen document: clipboard writes + fallback speech recognition.
 *
 * Clipboard: created with the CLIPBOARD reason, so execCommand('copy') works
 * without user activation.
 *
 * Recognition fallback: the primary recognizer is an extension-origin iframe in
 * the recorded page, but a page can ship `Permissions-Policy: microphone=()`
 * which blocks mic use in EVERY embedded frame regardless of user grants. This
 * document isn't embedded in any page, so no site policy applies. Plain
 * SpeechRecognition.start() historically produced no results in offscreen
 * documents (no default-mic routing), so we capture the mic ourselves with
 * getUserMedia — allowed here once the user granted it via a visible extension
 * page like the popup meter; offscreen docs can't prompt — and hand the track to
 * SpeechRecognition.start(track). A watchdog retries plain start() once, then
 * reports honestly so the overlay never claims a mic it doesn't have.
 */
(function () {
  'use strict';
  const MSG = self.SCF.MSG;
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
  const AUDIO_START_TIMEOUT_MS = 7000;

  function post(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {
      /* SW asleep */
    }
  }

  // ------------------------------------------------------------- clipboard

  function copyToClipboard(text) {
    const ta = document.getElementById('clip');
    ta.value = text || '';
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    ta.blur();
    return ok;
  }

  // ------------------------------------------------- fallback recognition

  let recognition = null;
  let recStream = null;
  let wantRec = false;
  let running = false;
  let audioLive = false;
  let triedPlain = false; // second chance: plain start() while the gUM stream holds the mic open
  let useTrack = true;
  let watchdog = null;
  let restartTimer = null;
  let lang = 'en-US';

  function postError(error, permState) {
    post({ type: MSG.TRANSCRIBE_ERROR, error, src: 'offscreen', permState: permState || null });
  }

  function releaseStream() {
    if (recStream) {
      try {
        recStream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        /* ignore */
      }
      recStream = null;
    }
  }

  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (audioLive || !wantRec) return;
      // no audio reached recognition — kill this attempt
      try {
        if (recognition) recognition.abort();
      } catch (e) {
        /* ignore */
      }
      recognition = null;
      if (!triedPlain) {
        triedPlain = true;
        useTrack = false;
        startSR();
      } else {
        wantRec = false;
        releaseStream();
        postError('offscreen-no-audio');
      }
    }, AUDIO_START_TIMEOUT_MS);
  }

  function build() {
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    // Every handler ignores events from a superseded instance: the watchdog
    // abort()s and replaces the recognition object, and the old one's onend
    // would otherwise schedule a competing restart.
    r.onstart = () => {
      if (recognition !== r) return;
      running = true;
    };
    r.onaudiostart = () => {
      if (recognition !== r) return;
      audioLive = true;
      clearTimeout(watchdog);
      post({ type: MSG.MIC_LISTENING, src: 'offscreen' });
    };
    r.onresult = (event) => {
      if (recognition !== r) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0] && res[0].transcript ? res[0].transcript : '';
        if (res.isFinal) {
          const f = text.trim();
          if (f) post({ type: MSG.TRANSCRIPT_SEGMENT, final: true, text: f, t: Date.now(), src: 'offscreen' });
        } else {
          interim += text;
        }
      }
      if (interim.trim()) {
        post({ type: MSG.TRANSCRIPT_SEGMENT, final: false, text: interim.trim(), t: Date.now(), src: 'offscreen' });
      }
    };
    r.onerror = (event) => {
      if (recognition !== r) return;
      const err = event.error || 'unknown';
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') {
        wantRec = false;
        clearTimeout(watchdog);
        releaseStream();
        postError(err, 'granted'); // getUserMedia succeeded, so permission isn't the problem
      }
    };
    r.onend = () => {
      if (recognition !== r) return;
      running = false;
      if (!wantRec) {
        releaseStream();
        return;
      }
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (wantRec) startSR();
      }, 250);
    };
    return r;
  }

  function startSR() {
    if (!wantRec) return;
    if (!recognition) recognition = build();
    audioLive = false;
    armWatchdog();
    const track = useTrack && recStream ? recStream.getAudioTracks()[0] : null;
    try {
      if (track) recognition.start(track);
      else recognition.start();
    } catch (e) {
      try {
        recognition = build();
        if (track) recognition.start(track);
        else recognition.start();
      } catch (e2) {
        wantRec = false;
        clearTimeout(watchdog);
        releaseStream();
        postError('restart-failed');
      }
    }
  }

  async function startRecognition(msgLang) {
    if (wantRec) return; // already running (e.g. duplicate resume)
    if (!SR) {
      postError('speech-recognition-unavailable');
      return;
    }
    lang = msgLang || 'en-US';
    wantRec = true;
    triedPlain = false;
    useTrack = true;
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      wantRec = false;
      let permState = null;
      try {
        const s = await navigator.permissions.query({ name: 'microphone' });
        permState = s.state;
      } catch (e2) {
        /* leave null */
      }
      postError(e && e.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture', permState || 'denied');
      return;
    }
    if (!wantRec) {
      // stopped while getUserMedia was pending
      releaseStream();
      return;
    }
    startSR();
  }

  function stopRecognition() {
    wantRec = false;
    clearTimeout(watchdog);
    clearTimeout(restartTimer);
    if (recognition) {
      try {
        recognition.stop(); // graceful: lets the final segment flush; onend releases the stream
      } catch (e) {
        releaseStream();
      }
    } else {
      releaseStream();
    }
    // safety: if onend never fires, don't hold the mic open
    setTimeout(() => {
      if (!wantRec && !running) releaseStream();
    }, 2000);
  }

  // ------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === MSG.COPY_TO_CLIPBOARD) {
      sendResponse({ ok: copyToClipboard(msg.text) });
      return true;
    }
    if (msg.type === MSG.OFFSCREEN_RECOGNIZE) {
      startRecognition(msg.lang);
      return;
    }
    if (msg.type === MSG.RECOGNIZER_STOP) {
      stopRecognition();
      return;
    }
  });
})();
