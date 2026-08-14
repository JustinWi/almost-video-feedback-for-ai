/*
 * Mic-failure triage (pure logic, dual-exported, unit-tested).
 *
 * A "not-allowed" from Web Speech in the recognizer iframe has three very
 * different causes, each needing a different response:
 *   - the PAGE's Permissions-Policy blocks microphone for embedded frames
 *     (nothing the user can grant fixes it -> run recognition in the offscreen
 *     document instead, which no page policy can touch)
 *   - the EXTENSION's mic permission isn't persistently granted (revoked, or
 *     granted "this time only" via the popup meter -> tell the user exactly
 *     which button to click; a fallback can't prompt and would fail the same way)
 *   - Chrome's speech SERVICE failed even though the mic is fine
 * The recognizer reports what it observed (policyAllowed from the document's
 * permissions policy, permState from navigator.permissions); this classifies
 * that evidence into { kind, fallback }.
 *
 * kind: 'page-blocked' | 'permission' | 'service' | 'no-audio' | 'blocked' | 'other'
 * fallback: whether the SW should retry recognition in the offscreen document.
 * When the evidence is inconclusive (no permState), fallback doubles as the
 * probe: it succeeds if the page was the blocker, and fails with a precise
 * 'permission' verdict from getUserMedia if the grant was the problem.
 */
(function (root) {
  'use strict';

  function classify(input) {
    const i = input || {};
    const error = String(i.error || '').toLowerCase();
    const src = i.src === 'offscreen' ? 'offscreen' : 'iframe';
    const permKnownBad = i.permState === 'denied' || i.permState === 'prompt';
    const result = (kind, fallback) => ({ kind, fallback: !!fallback && src !== 'offscreen' });

    if (error === 'audio-capture' || error === 'offscreen-no-audio') return result('no-audio', false);

    if (error === 'not-allowed' || error === 'service-not-allowed') {
      if (i.policyAllowed === false) return result('page-blocked', true);
      if (permKnownBad) return result('permission', false);
      if (error === 'service-not-allowed') return result('service', true);
      // not-allowed with permission granted/unknown and no policy verdict:
      // ambiguous — let the offscreen attempt disambiguate
      return result('blocked', true);
    }

    // no-speech / network / aborted / restart-failed / unavailable: transient or
    // terminal-but-quiet; the recognizer's own restart loop handles these
    return result('other', false);
  }

  root.SCF = root.SCF || {};
  root.SCF.micTriage = root.SCF.micTriage || { classify };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { classify };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
