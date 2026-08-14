/*
 * Tiny dependency-free test runner for the pure-logic modules.
 * Run: node test/run.cjs
 */
'use strict';
const assert = require('assert');
const imageHash = require('../src/background/image-hash.js');
const gesture = require('../src/content/gesture.js');
const exporter = require('../src/background/exporter.js');
const loomTimeline = require('../src/background/loom-timeline.js');
const zip = require('../src/common/zip.js');
const protocol = require('../src/common/protocol.js');
const micTriage = require('../src/background/mic-triage.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('    ' + (err && err.message ? err.message : err));
  }
}

// ---- helpers ----
function gradientImage(increasing) {
  const w = imageHash.HASH_W; // 9
  const h = imageHash.HASH_H; // 8
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = x / (w - 1);
      const v = Math.round((increasing ? t : 1 - t) * 255);
      const i = (y * w + x) * 4;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function circlePoints(cx, cy, r, loops, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 * loops;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

console.log('image-hash:');

test('bitsToHex maps nibbles', () => {
  assert.strictEqual(imageHash.bitsToHex('0000'.repeat(16)), '0'.repeat(16));
  assert.strictEqual(imageHash.bitsToHex('1111'.repeat(16)), 'f'.repeat(16));
  assert.strictEqual(imageHash.bitsToHex('1010'.repeat(16)), 'a'.repeat(16));
});

test('dHash of increasing gradient is all zeros', () => {
  // left darker than right => g1 > g2 is false => 0 bits
  assert.strictEqual(imageHash.dHash(gradientImage(true)), '0'.repeat(16));
});

test('dHash of decreasing gradient is all ones', () => {
  assert.strictEqual(imageHash.dHash(gradientImage(false)), 'f'.repeat(16));
});

test('hammingDistance: identical = 0, opposite = 64', () => {
  assert.strictEqual(imageHash.hammingDistance('0'.repeat(16), '0'.repeat(16)), 0);
  assert.strictEqual(imageHash.hammingDistance('0'.repeat(16), 'f'.repeat(16)), 64);
});

test('hammingDistance counts single bit', () => {
  assert.strictEqual(imageHash.hammingDistance('0000000000000001', '0000000000000000'), 1);
  assert.strictEqual(imageHash.hammingDistance('0000000000000003', '0000000000000000'), 2);
});

test('hammingDistance mismatched/empty => 64', () => {
  assert.strictEqual(imageHash.hammingDistance('', 'abc'), 64);
  assert.strictEqual(imageHash.hammingDistance(null, 'abc'), 64);
});

test('isDuplicate respects threshold', () => {
  assert.strictEqual(imageHash.isDuplicate('0000000000000003', '0000000000000000', 6), true);
  assert.strictEqual(imageHash.isDuplicate('00000000000000ff', '0000000000000000', 6), false); // 8 bits
});

console.log('triggers:');

test('click is a priority trigger (evaluated individually, not coalesced)', () => {
  // Priority means a click is never collapsed into a neighbouring request and never
  // hits the blunt whole-frame cull; its own region-aware dedup decides keep/cull.
  assert.ok(protocol.PRIORITY_TRIGGERS.has(protocol.TRIGGER.CLICK));
});

test('priority-trigger contract: intentional triggers bypass the blunt cull, ambient ones do not', () => {
  const P = protocol.PRIORITY_TRIGGERS;
  for (const t of ['start', 'navigation', 'route', 'click', 'selection', 'circle', 'forced', 'annotate']) {
    assert.ok(P.has(t), t + ' should bypass the whole-frame cull');
  }
  for (const t of ['dwell', 'scroll', 'heartbeat']) {
    assert.ok(!P.has(t), t + ' should remain subject to the whole-frame cull');
  }
});

console.log('region dedup:');

test('toGray flattens RGBA to luminance bytes', () => {
  const data = Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]);
  const g = imageHash.toGray({ width: 2, height: 1, data });
  assert.strictEqual(g[0], 255);
  assert.strictEqual(g[1], 0);
});

test('changeRatio: identical => 0, mismatched length => 1', () => {
  const a = new Uint8Array(16).fill(100);
  const b = new Uint8Array(16).fill(100);
  assert.strictEqual(imageHash.changeRatio(a, b, 4, 4, null, 18), 0);
  assert.strictEqual(imageHash.changeRatio(a, new Uint8Array(9), 4, 4, null, 18), 1);
});

test('changeRatio: respects eps and counts changed cells globally', () => {
  const a = new Uint8Array(16).fill(100);
  const b = new Uint8Array(16).fill(100);
  b[5] = 200; // one cell, delta 100
  assert.strictEqual(imageHash.changeRatio(a, b, 4, 4, null, 18), 1 / 16);
  assert.strictEqual(imageHash.changeRatio(a, b, 4, 4, null, 150), 0); // below eps
});

test('changeRatio: a box isolates a local change the global ratio barely sees', () => {
  const a = new Uint8Array(16).fill(100);
  const b = new Uint8Array(16).fill(100);
  b[5] = 200; // cell at (x=1,y=1)
  const box = imageHash.regionBox(4, 4, 0.25, 0.25, 0); // centered on (1,1), 1 cell
  assert.strictEqual(imageHash.changeRatio(a, b, 4, 4, box, 18), 1); // 100% of the box
  assert.ok(imageHash.changeRatio(a, b, 4, 4, null, 18) < 0.1); // tiny globally
});

test('regionBox centers a square of half-size radius on the click', () => {
  assert.deepStrictEqual(imageHash.regionBox(64, 40, 0.5, 0.5, 9), { x0: 23, y0: 11, x1: 42, y1: 30 });
});

console.log('gesture:');

test('pathLength of a 3-4-5 segment', () => {
  assert.strictEqual(gesture.pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
  assert.strictEqual(gesture.pathLength([{ x: 1, y: 1 }]), 0);
});

test('boundingBoxDiagonal', () => {
  assert.strictEqual(gesture.boundingBoxDiagonal([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
  assert.strictEqual(gesture.boundingBoxDiagonal([]), 0);
});

const OPTS = { circleMinPathPx: 320, circleRatio: 3.2 };

test('straight long drag is NOT a circle', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 400, y: 0 }];
  const r = gesture.analyzeGesture(pts, OPTS);
  assert.strictEqual(r.isCircle, false);
  assert.ok(r.ratio < 1.5, 'ratio should be ~1 for a straight line, got ' + r.ratio);
});

test('tight repeated circling IS a circle', () => {
  const pts = circlePoints(100, 100, 20, 3, 60);
  const r = gesture.analyzeGesture(pts, OPTS);
  assert.ok(r.pathLength >= 320, 'pathLength ' + r.pathLength);
  assert.ok(r.ratio >= 3.2, 'ratio ' + r.ratio);
  assert.strictEqual(r.isCircle, true);
});

test('one small loop is not enough path to trigger', () => {
  const pts = circlePoints(100, 100, 10, 1, 24); // circumference ~63px
  const r = gesture.analyzeGesture(pts, OPTS);
  assert.strictEqual(r.isCircle, false);
});

console.log('exporter:');

const sampleEvents = [
  { id: 1, t: 1000, type: 'screenshot', seq: 1, trigger: 'start', url: 'http://app/', title: 'App' },
  { id: 2, t: 2000, type: 'transcript', final: true, text: 'the save button is broken' },
  {
    id: 3, t: 2500, type: 'screenshot', seq: 2, trigger: 'click', url: 'http://app/', title: 'App',
    element: { tag: 'BUTTON', id: 'save', classes: 'btn primary', text: 'Save' },
  },
  { id: 4, t: 60000, type: 'transcript', final: true, text: 'unrelated note far away' },
];
const sampleMeta = { startedAt: 1000, endedAt: 61000, startedAtText: '2026-06-20 14:30' };

test('build returns sequential screenshot files', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  assert.strictEqual(r.screenshots.length, 2);
  assert.strictEqual(r.screenshots[0].file, 'screenshots/0001.png');
  assert.strictEqual(r.screenshots[1].file, 'screenshots/0002.png');
});

test('markdown embeds screenshots, quotes, pages, element', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  assert.ok(r.markdown.includes('screenshots/0002.png'), 'image ref');
  assert.ok(r.markdown.includes('the save button is broken'), 'nearest-screenshot quote');
  assert.ok(r.markdown.includes('Pages visited'), 'pages section');
  assert.ok(r.markdown.includes('http://app/'), 'page url');
  assert.ok(r.markdown.includes('button#save'), 'element selector');
  assert.ok(r.markdown.includes('Save'), 'element text');
});

test('far-away transcript becomes a floating spoken note', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  assert.ok(r.markdown.includes('unrelated note far away'));
  assert.ok(/spoken:/.test(r.markdown), 'rendered as a spoken note');
});

test('json has correct shape and counts', () => {
  const r = exporter.build(sampleEvents, sampleMeta);
  const j = JSON.parse(r.json);
  assert.strictEqual(j.durationMs, 60000);
  assert.strictEqual(j.screenshots.length, 2);
  assert.strictEqual(j.transcript.length, 2);
  assert.deepStrictEqual(j.screenshots[1].spoken, ['the save button is broken']);
});

test('relTime formats mm:ss and h:mm:ss', () => {
  assert.strictEqual(exporter.relTime(0), '00:00');
  assert.strictEqual(exporter.relTime(65000), '01:05');
  assert.strictEqual(exporter.relTime(3661000), '1:01:01');
});

test('frame trigger renders a video-frame label', () => {
  const ev = [{ id: 1, t: 1000, type: 'screenshot', seq: 1, trigger: 'frame', url: 'https://www.loom.com/share/abc', title: 'Demo' }];
  const r = exporter.build(ev, { startedAt: 1000, endedAt: 1000, startedAtText: 'x' });
  assert.ok(r.markdown.includes('🎞️ Video frame'), 'frame label rendered');
});

test('empty session still builds', () => {
  const r = exporter.build([], {});
  assert.ok(typeof r.markdown === 'string' && r.markdown.length > 0);
  assert.strictEqual(r.screenshots.length, 0);
});

console.log('loom-timeline:');

test('parseTimestamp parses mm:ss and h:mm:ss to ms', () => {
  assert.strictEqual(loomTimeline.parseTimestamp('00:00'), 0);
  assert.strictEqual(loomTimeline.parseTimestamp('00:09'), 9000);
  assert.strictEqual(loomTimeline.parseTimestamp('01:05'), 65000);
  assert.strictEqual(loomTimeline.parseTimestamp('1:02:03'), 3723000);
});

test('parseTimestamp rejects junk', () => {
  assert.strictEqual(loomTimeline.parseTimestamp('hello'), null);
  assert.strictEqual(loomTimeline.parseTimestamp(''), null);
  assert.strictEqual(loomTimeline.parseTimestamp(null), null);
});

test('buildTargets always includes t=0 and every segment time, sorted+unique', () => {
  const r = loomTimeline.buildTargets([9000, 9000, 2000], { floorMs: 15000, maxFrames: 300 });
  assert.deepStrictEqual(r, [0, 2000, 9000]);
});

test('buildTargets fills gaps larger than floorMs', () => {
  // 0 -> 40000 is a 40s gap; floor 15s -> insert 15000, 30000
  const r = loomTimeline.buildTargets([40000], { floorMs: 15000, maxFrames: 300 });
  assert.deepStrictEqual(r, [0, 15000, 30000, 40000]);
});

test('buildTargets respects maxFrames by even subsampling (keeps first + last)', () => {
  const segs = [10000, 20000, 30000, 40000, 50000]; // anchors incl 0 -> 6 targets
  const r = loomTimeline.buildTargets(segs, { floorMs: 60000, maxFrames: 3 });
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0], 0);
  assert.strictEqual(r[r.length - 1], 50000);
});

test('buildTargets on empty segments yields just [0]', () => {
  assert.deepStrictEqual(loomTimeline.buildTargets([], { floorMs: 15000, maxFrames: 300 }), [0]);
});

console.log('zip:');

test('crc32 of "123456789" is 0xCBF43926', () => {
  const bytes = Buffer.from('123456789', 'ascii');
  assert.strictEqual(zip.crc32(bytes), 0xcbf43926);
});

test('buildZipBytes produces a valid-looking archive', () => {
  const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
  const bytes = zip.buildZipBytes([
    { name: 'feedback.md', data: enc('# hello') },
    { name: 'screenshots/0001.png', data: new Uint8Array([1, 2, 3, 4]) },
  ]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // first local file header signature PK\x03\x04
  assert.strictEqual(dv.getUint32(0, true), 0x04034b50);
  // EOCD is the last 22 bytes
  const eocd = bytes.length - 22;
  assert.strictEqual(dv.getUint32(eocd, true), 0x06054b50, 'EOCD signature');
  assert.strictEqual(dv.getUint16(eocd + 10, true), 2, 'total entries');
  // central dir offset points at a central-directory header PK\x01\x02
  const cdOff = dv.getUint32(eocd + 16, true);
  assert.strictEqual(dv.getUint32(cdOff, true), 0x02014b50, 'central dir signature');
});

test('buildZipBytes round-trips entry names + data', () => {
  const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
  const name = 'session.json';
  const data = enc('{"a":1}');
  const bytes = zip.buildZipBytes([{ name, data }]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = dv.getUint16(26, true);
  const storedName = Buffer.from(bytes.slice(30, 30 + nameLen)).toString('utf8');
  assert.strictEqual(storedName, name);
  const storedData = Buffer.from(bytes.slice(30 + nameLen, 30 + nameLen + data.length)).toString('utf8');
  assert.strictEqual(storedData, '{"a":1}');
});

// ---- mic-triage: classify why speech recognition failed ----

test('mic-triage: page Permissions-Policy block -> page-blocked + offscreen fallback', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'iframe', policyAllowed: false, permState: 'granted' });
  assert.deepStrictEqual(v, { kind: 'page-blocked', fallback: true });
});

test('mic-triage: policy verdict wins even with permission unknown', () => {
  const v = micTriage.classify({ error: 'service-not-allowed', src: 'iframe', policyAllowed: false, permState: null });
  assert.deepStrictEqual(v, { kind: 'page-blocked', fallback: true });
});

test('mic-triage: permission prompt (the "Allow this time" trap) -> permission, no fallback', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'iframe', policyAllowed: true, permState: 'prompt' });
  assert.deepStrictEqual(v, { kind: 'permission', fallback: false });
});

test('mic-triage: permission denied -> permission, no fallback', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'iframe', policyAllowed: null, permState: 'denied' });
  assert.deepStrictEqual(v, { kind: 'permission', fallback: false });
});

test('mic-triage: not-allowed despite granted permission -> ambiguous, fallback probes', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'iframe', policyAllowed: true, permState: 'granted' });
  assert.deepStrictEqual(v, { kind: 'blocked', fallback: true });
});

test('mic-triage: not-allowed with no diagnostics at all -> fallback probes', () => {
  const v = micTriage.classify({ error: 'not-allowed' });
  assert.deepStrictEqual(v, { kind: 'blocked', fallback: true });
});

test('mic-triage: service-not-allowed with granted mic -> service, one fallback try', () => {
  const v = micTriage.classify({ error: 'service-not-allowed', src: 'iframe', policyAllowed: true, permState: 'granted' });
  assert.deepStrictEqual(v, { kind: 'service', fallback: true });
});

test('mic-triage: service-not-allowed with ungranted mic reads as permission', () => {
  const v = micTriage.classify({ error: 'service-not-allowed', src: 'iframe', policyAllowed: true, permState: 'prompt' });
  assert.deepStrictEqual(v, { kind: 'permission', fallback: false });
});

test('mic-triage: offscreen source never falls back further', () => {
  const v = micTriage.classify({ error: 'not-allowed', src: 'offscreen', policyAllowed: null, permState: 'granted' });
  assert.strictEqual(v.fallback, false);
});

test('mic-triage: hardware/no-audio failures are terminal', () => {
  assert.deepStrictEqual(micTriage.classify({ error: 'audio-capture', src: 'iframe' }), { kind: 'no-audio', fallback: false });
  assert.deepStrictEqual(micTriage.classify({ error: 'offscreen-no-audio', src: 'offscreen' }), { kind: 'no-audio', fallback: false });
});

test('mic-triage: transient recognizer errors classify as other, no UI reaction', () => {
  for (const error of ['no-speech', 'network', 'aborted', 'restart-failed', 'speech-recognition-unavailable']) {
    const v = micTriage.classify({ error, src: 'iframe' });
    assert.deepStrictEqual(v, { kind: 'other', fallback: false }, error);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
