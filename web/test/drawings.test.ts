import { test } from 'node:test';
import assert from 'node:assert';
import { timeToLogical, logicalToTime, buildOps, hitOps, hitHandle, finalize, newDrawing, sanitize, toolDef, TOOLS, FIB_LEVELS, type Drawing, type Proj } from '../app/app/chartkit/drawings';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
// one pixel per second, price 1 = 1px going up
const pr: Proj = { w: 600, h: 300, tf: 5, px: (p) => ({ x: p.time, y: 300 - p.price }), price: (b) => b.toFixed(1), time: (s) => String(s) };
const mk = (kind: Drawing['kind'], pts: [number, number][], over: Partial<Drawing> = {}): Drawing => ({ id: 'x', kind, pts: pts.map(([time, price]) => ({ time, price })), color: '#f5b83d', width: 2, style: 'solid', fill: 0, ...over });

test('time <-> logical: exact on bars, interpolated across gaps, extended into the future and past', () => {
  const times = [100, 105, 110, 150, 155]; // a 40s gap between index 2 and 3
  near(timeToLogical(100, times, 5)!, 0); near(timeToLogical(110, times, 5)!, 2); near(timeToLogical(130, times, 5)!, 2.5);
  near(timeToLogical(165, times, 5)!, 4 + 2); near(timeToLogical(90, times, 5)!, -2);
  for (const t of [90, 100, 107, 130, 154, 190]) near(logicalToTime(timeToLogical(t, times, 5)!, times, 5)!, t);
  assert.strictEqual(timeToLogical(1, [], 5), null);
});

test('a trend line is hit near the line and not away from it; extension reaches the edge of the chart', () => {
  const d = mk('trend', [[100, 50], [200, 150]]);
  const { ops, handles } = buildOps(d, pr);
  assert.ok(hitOps(ops, 150, 300 - 100, 7));       // on the line
  assert.ok(hitOps(ops, 150, 300 - 104, 7));       // within tolerance
  assert.ok(!hitOps(ops, 150, 300 - 140, 7));      // far
  assert.ok(!hitOps(ops, 400, 300 - 350, 7));      // beyond the end without extension
  assert.strictEqual(handles.length, 2);
  const ray = buildOps({ ...d, extR: true }, pr);
  assert.ok(hitOps(ray.ops, 400, 300 - 350, 7));   // a ray keeps going
  assert.ok(!hitOps(ray.ops, 20, 300 - (-30), 7)); // but not to the left
  const ext = buildOps({ ...d, extL: true, extR: true }, pr);
  assert.ok(hitOps(ext.ops, 20, 300 - (-30), 7));
});

test('horizontal and vertical lines span the whole chart', () => {
  const h = buildOps(mk('hline', [[100, 80]]), pr);
  assert.ok(hitOps(h.ops, 5, 300 - 80) && hitOps(h.ops, 590, 300 - 80) && !hitOps(h.ops, 300, 300 - 120));
  const v = buildOps(mk('vline', [[250, 10]]), pr);
  assert.ok(hitOps(v.ops, 250, 5) && hitOps(v.ops, 250, 290) && !hitOps(v.ops, 300, 100));
  const r = buildOps(mk('hray', [[300, 60]]), pr);
  assert.ok(hitOps(r.ops, 500, 300 - 60) && !hitOps(r.ops, 100, 300 - 60));
});

test('rectangles: filled ones are hit inside, empty ones only on the border; four corner handles', () => {
  const filled = buildOps(mk('rect', [[100, 50], [200, 150]], { fill: 0.2 }), pr);
  assert.ok(hitOps(filled.ops, 150, 300 - 100));
  const empty = buildOps(mk('rect', [[100, 50], [200, 150]], { fill: 0 }), pr);
  assert.ok(!hitOps(empty.ops, 150, 300 - 100) && hitOps(empty.ops, 100, 300 - 100) && hitOps(empty.ops, 150, 300 - 150));
  assert.strictEqual(filled.handles.length, 4);
  // dragging the corner that shares x with point 0 and y with point 1 changes exactly those two values
  const d = mk('rect', [[100, 50], [200, 150]]);
  const hs = buildOps(d, pr).handles; const idx = hitHandle(hs, 100, 300 - 150);
  hs[idx].set(d, { time: 90, price: 170 });
  assert.deepStrictEqual(d.pts, [{ time: 90, price: 50 }, { time: 200, price: 170 }]);
});

test('handles can be grabbed within reach and the nearest wins', () => {
  const hs = buildOps(mk('trend', [[100, 50], [110, 50]]), pr).handles;
  assert.strictEqual(hitHandle(hs, 101, 300 - 50), 0); assert.strictEqual(hitHandle(hs, 109, 300 - 50), 1); assert.strictEqual(hitHandle(hs, 300, 10), -1);
});

test('fib: level 0 sits on the end point, level 1 on the start point, others in between', () => {
  const d = mk('fib', [[100, 200], [200, 100]]); // a drop from 200 to 100
  const { ops } = buildOps(d, pr);
  const ys = ops.filter((o): o is Extract<typeof o, { t: 'line' }> => o.t === 'line' && o.dash.length === 0 && o.x1 === 100).map((o) => 300 - o.y1);
  near(ys[0], 100); // level 0 at the end price
  near(ys[FIB_LEVELS.findIndex((l) => l.v === 1)], 200); // level 1 at the start price
  near(ys[FIB_LEVELS.findIndex((l) => l.v === 0.5)], 150);
  near(ys[FIB_LEVELS.findIndex((l) => l.v === 0.618)], 100 + 100 * 0.618);
});

test('long/short: stop is mirrored automatically, a backwards drag is flipped, R:R is reward over risk', () => {
  const long = finalize({ ...mk('long', [[100, 100], [160, 130]]) });
  assert.deepStrictEqual(long.pts.map((p) => p.price), [100, 130, 70]);
  const flipped = finalize({ ...mk('long', [[100, 100], [160, 80]]) });
  assert.deepStrictEqual(flipped.pts.map((p) => p.price), [100, 120, 80]); // a long's target is always above entry
  const short = finalize({ ...mk('short', [[100, 100], [160, 70]]) });
  assert.deepStrictEqual(short.pts.map((p) => p.price), [100, 70, 130]);
  const { ops } = buildOps(long, pr);
  const text = ops.filter((o): o is Extract<typeof o, { t: 'text' }> => o.t === 'text').map((o) => o.lines.join(' '));
  assert.ok(text.some((t) => t.includes('R:R 1.00')), text.join('|'));
  assert.ok(text.some((t) => t.includes('Target 130.0 (+30.00%)')) && text.some((t) => t.includes('Stop 70.0 (-30.00%)')));
  assert.ok(hitOps(ops, 130, 300 - 115)); // inside the reward box
});

test('parallel channel: the second line is offset by the third point and both lines are clickable', () => {
  const d = finalize(mk('channel', [[100, 100], [200, 160]]));
  d.pts[2] = { time: 150, price: 100 }; // baseline at t=150 is price 130, so the offset is 30px down
  const { ops, handles } = buildOps(d, pr);
  assert.ok(hitOps(ops, 150, 300 - 130) && hitOps(ops, 150, 300 - 100));
  assert.strictEqual(handles.length, 3);
  handles[2].set(d, { time: 999, price: 90 });
  assert.strictEqual(d.pts[2].time, 150); // the width handle stays centred on the baseline
});

test('a channel that is still being placed (two points) draws its base line and does not throw', () => {
  const d = mk('channel', [[100, 100], [200, 160]]);
  const { ops, handles } = buildOps(d, pr);
  assert.ok(ops.length === 1 && handles.length === 2);
  const l = mk('long', [[100, 100], [160, 130]]); // same for a position before its stop exists
  assert.doesNotThrow(() => buildOps(l, pr));
});

test('text and brush can be clicked; text keeps its note', () => {
  const t = mk('text', [[300, 120]], { text: 'Resistance' });
  const { ops } = buildOps(t, pr);
  assert.ok(hitOps(ops, 310, 300 - 120) && !hitOps(ops, 100, 300 - 120));
  const b = buildOps(mk('brush', [[100, 100], [120, 130], [140, 100]]), pr);
  assert.ok(hitOps(b.ops, 110, 300 - 115) && !hitOps(b.ops, 300, 10));
});

test('a point that cannot be placed on the chart yields nothing to draw (no crash)', () => {
  const none: Proj = { ...pr, px: () => null };
  assert.deepStrictEqual(buildOps(mk('trend', [[1, 1], [2, 2]]), none), { ops: [], handles: [] });
});

test('every tool creates a drawing of the right shape', () => {
  for (const t of TOOLS) {
    const d = newDrawing(t, { time: 1, price: 2 });
    assert.strictEqual(d.kind, t.kind);
    assert.ok(d.pts.length >= 1);
    if (t.id === 'ray') assert.ok(d.extR && !d.extL);
    if (t.id === 'extended') assert.ok(d.extR && d.extL);
  }
  assert.strictEqual(toolDef('hline')!.need, 1);
});

test('stored drawings are validated: junk, bad colours, NaN and oversize values are dropped or repaired', () => {
  const good = mk('trend', [[1, 2], [3, 4]]);
  const out = sanitize([good, null, 7, { kind: 'bogus', pts: [] }, { ...good, id: 'n', pts: [{ time: NaN, price: 1 }, { time: 1, price: 2 }] }, { ...good, id: 'c', color: 'javascript:alert(1)', width: 99, fill: 5, text: 'x'.repeat(500) }]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, 'x');
  assert.strictEqual(out[1].color, '#f5b83d'); assert.strictEqual(out[1].width, 6); assert.strictEqual(out[1].fill, 1); assert.strictEqual(out[1].text!.length, 120);
  assert.deepStrictEqual(sanitize('nope'), []);
  assert.strictEqual(sanitize(new Array(500).fill(good)).length, 200);
});
