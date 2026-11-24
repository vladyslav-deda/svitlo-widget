const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/schedule');
const fixture = require('./fixtures/voe-2026-11-23.json');

test('slot semantics: first = off in first half, second = off in second half', () => {
  const slots = {};
  for (let k = 1; k <= 24; k++) slots[k] = 'yes';
  slots[12] = 'no';      // 11:00-12:00
  slots[13] = 'first';   // 12:00-12:30
  slots[20] = 'second';  // 19:30-20:00
  slots[21] = 'no';      // 20:00-21:00
  assert.deepStrictEqual(S.slotsToIntervals(slots), [[660, 750], [1170, 1260]]);
});

test('slot 1 is 00:00-01:00 and slot 24 runs to midnight', () => {
  const slots = {};
  for (let k = 1; k <= 24; k++) slots[k] = 'yes';
  slots[1] = 'no'; slots[24] = 'no';
  assert.deepStrictEqual(S.slotsToIntervals(slots), [[0, 60], [1380, 1440]]);
});

test('day keys map to calendar dates in winter and summer', () => {
  assert.strictEqual(S.keyToDate('1795384800'), '2026-11-23'); // fixture "today"
  assert.strictEqual(S.keyToDate('1795471200'), '2026-11-24');
  // parser computes midnight with fixed +02:00 also in summer: 2026-07-10T00:00+02:00
  assert.strictEqual(S.keyToDate(String(Date.UTC(2026, 6, 9, 22) / 1000)), '2026-07-10');
});

test('real fixture: queue 3.1 on 23.11 is off 08-12 and 16-18; 5.2 has a half-hour slot', () => {
  const p = S.parseSource(fixture);
  const d = p.days['2026-11-23'];
  assert.ok(d.published);
  assert.deepStrictEqual(d.queues['3.1'], [[480, 720], [960, 1080]]);
  assert.deepStrictEqual(d.queues['5.2'], [[420, 480], [660, 750], [960, 1200]]);
  assert.strictEqual(p.days['2026-11-24'].published, false, 'all-yes day counts as not published');
});

test('queueView at 14:05 Kyiv: power on, off at 16:00; tomorrow unpublished', () => {
  const p = S.parseSource(fixture);
  const now = new Date('2026-11-23T12:05:00Z'); // 14:05 Kyiv (UTC+2)
  const v = S.queueView(p, '3.1', now);
  assert.strictEqual(v.minutes, 845);
  assert.deepStrictEqual(v.status, { off: false, until: 960, start: 960, end: 1080 });
  assert.strictEqual(v.tomorrow, null);
});

test('queueView during outage and after last outage', () => {
  const p = S.parseSource(fixture);
  const off = S.queueView(p, '3.1', new Date('2026-11-23T14:40:00Z')); // 16:40
  assert.strictEqual(off.status.off, true);
  assert.strictEqual(off.status.until, 1080);
  const late = S.queueView(p, '3.1', new Date('2026-11-23T19:00:00Z')); // 21:00
  assert.deepStrictEqual(late.status, { off: false, until: null });
});

test('after midnight the old file has no "today" -> unknown, not "power on"', () => {
  const p = S.parseSource(fixture);
  const v = S.queueView(p, '3.1', new Date('2026-11-25T08:00:00Z'));
  assert.strictEqual(v.today, null);
  assert.strictEqual(v.status, null);
});

test('staleness', () => {
  const p = S.parseSource(fixture);
  assert.strictEqual(S.isStale(p, new Date(p.updatedAt + 60 * 1000)), false);
  assert.strictEqual(S.isStale(p, new Date(p.updatedAt + 4 * 3600 * 1000)), true);
  assert.strictEqual(S.isStale({ ...p, sourceOk: false }, new Date(p.updatedAt)), true);
});

test('formatting', () => {
  assert.strictEqual(S.hm(960), '16:00');
  assert.strictEqual(S.hShort(115), '1:55');
  assert.strictEqual(S.durLong(115), '1 год 55 хв');
  assert.strictEqual(S.durLong(120), '2 год');
});

test('no more outages today -> next outage comes from tomorrow', () => {
  const p = S.parseSource(fixture);
  p.days['2026-11-24'] = { published: true, queues: { '3.1': [[360, 480]] } };
  const v = S.queueView(p, '3.1', new Date('2026-11-23T21:16:00Z')); // 23:16 Kyiv
  assert.deepStrictEqual(v.status, { off: false, until: 1800, start: 1800, end: 1920, tomorrow: true });
  assert.strictEqual(S.hm(v.status.until), '06:00');
  assert.strictEqual(v.status.until - v.minutes, 404); // 6:44 left
});

test('outage running past midnight continues into tomorrow', () => {
  const p = { updatedAt: 1, sourceOk: true, days: {
    '2026-11-23': { published: true, queues: { '3.1': [[1320, 1440]] } },
    '2026-11-24': { published: true, queues: { '3.1': [[0, 120]] } } } };
  const v = S.queueView(p, '3.1', new Date('2026-11-23T21:30:00Z')); // 23:30
  assert.strictEqual(v.status.off, true);
  assert.strictEqual(S.hm(v.status.until), '02:00');
});

// ---------- schedule change detection ----------
const slotsFrom = (off) => { const s = {}; for (let k = 1; k <= 24; k++) s[k] = off.includes(k) ? 'no' : 'yes'; return s; };
const KEY_24 = '1795471200', KEY_25 = '1795557600'; // 2026-11-24, 2026-11-25
const src = (days) => {
  const data = {};
  for (const [key, q] of Object.entries(days)) {
    data[key] = {};
    for (const id of S.QUEUE_IDS) data[key]['GPV' + id] = slotsFrom(q[id] || []);
  }
  return S.parseSource({ fact: { data }, lastUpdated: 1795500000 });
};
const AT_1405 = new Date('2026-11-24T14:05:00+02:00');

test('minusIntervals: set difference at minute resolution', () => {
  assert.deepStrictEqual(S.minusIntervals([[600, 720]], [[630, 660]]), [[600, 630], [660, 720]]);
  assert.deepStrictEqual(S.minusIntervals([[600, 720]], [[0, 1440]]), []);
  assert.deepStrictEqual(S.minusIntervals([], [[0, 60]]), []);
});

test('scheduleChanges: identical data -> nothing', () => {
  const a = src({ [KEY_24]: { '6.2': [7, 8, 19, 20] } });
  assert.deepStrictEqual(S.scheduleChanges(a, a, ['6.2'], AT_1405), []);
});

test('scheduleChanges: tomorrow gets published', () => {
  const a = src({ [KEY_24]: { '6.2': [19, 20] }, [KEY_25]: {} });
  const b = src({ [KEY_24]: { '6.2': [19, 20] }, [KEY_25]: { '6.2': [9, 10], '1.1': [3] } });
  const c = S.scheduleChanges(a, b, ['6.2'], AT_1405);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'published');
  assert.strictEqual(c[0].today, false);
  assert.deepStrictEqual(c[0].intervals, [[480, 600]]);
});

test('scheduleChanges: tomorrow published but my queue has no outages -> still reported, empty list', () => {
  const a = src({ [KEY_24]: { '6.2': [19] }, [KEY_25]: {} });
  const b = src({ [KEY_24]: { '6.2': [19] }, [KEY_25]: { '1.1': [3] } });
  const c = S.scheduleChanges(a, b, ['6.2'], AT_1405);
  assert.deepStrictEqual(c.map((x) => [x.kind, x.intervals]), [['published', []]]);
});

test('scheduleChanges: today gets an extra outage -> changed with added range', () => {
  const a = src({ [KEY_24]: { '6.2': [19, 20] } });
  const b = src({ [KEY_24]: { '6.2': [17, 19, 20] } });
  const [c] = S.scheduleChanges(a, b, ['6.2'], AT_1405);
  assert.strictEqual(c.kind, 'changed');
  assert.strictEqual(c.today, true);
  assert.deepStrictEqual(c.added, [[960, 1020]]);
  assert.deepStrictEqual(c.removed, []);
  assert.deepStrictEqual(c.intervals, [[960, 1020], [1080, 1200]]);
});

test('scheduleChanges: edits to outages that already ended are ignored', () => {
  const a = src({ [KEY_24]: { '6.2': [7, 8, 19, 20] } });
  const b = src({ [KEY_24]: { '6.2': [7, 19, 20] } }); // morning shortened, it is 14:05 now
  assert.deepStrictEqual(S.scheduleChanges(a, b, ['6.2'], AT_1405), []);
});

test('scheduleChanges: today cancelled entirely -> changed, removed everything ahead', () => {
  const a = src({ [KEY_24]: { '6.2': [19, 20] } });
  const b = src({ [KEY_24]: {} });
  const [c] = S.scheduleChanges(a, b, ['6.2'], AT_1405);
  assert.strictEqual(c.kind, 'changed');
  assert.deepStrictEqual(c.intervals, []);
  assert.deepStrictEqual(c.removed, [[1080, 1200]]);
});

test('scheduleChanges: other queues changing does not concern me; vanished day is ignored', () => {
  const a = src({ [KEY_24]: { '6.2': [19], '1.1': [3] }, [KEY_25]: { '6.2': [9] } });
  const b = src({ [KEY_24]: { '6.2': [19], '1.1': [22] } });
  assert.deepStrictEqual(S.scheduleChanges(a, b, ['6.2'], AT_1405), []);
});
