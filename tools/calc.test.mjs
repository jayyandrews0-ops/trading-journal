// Unit tests for the equity-curve math. Run: node --test 'tools/**/*.test.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';

import { equityPoints, manualBalanceEvents, niceTicks, summarize,
  setupLabel, bySetup, byGrade, SETUP_FIELDS,
  dayKey, groupByDay, dayLabel, weekKey, riskStatus,
  monthGrid, dayState } from '../calc.js';
import { liveEquitySeries } from '../live.js';

test('equityPoints: point 0 is the start, one point per trade', () => {
  const pts = equityPoints(100, [3.1, -0.05, 0.8, -0.05, -0.72]
    .map((delta, k) => ({ delta, time: `2026-10-0${k + 5}T10:00` })));
  assert.equal(pts[1].time, '2026-10-05T10:00');
  assert.equal(pts.length, 6);
  assert.deepEqual(pts[0], { i: 0, value: 100, kind: 'start' });
  assert.ok(Math.abs(pts[5].value - 103.08) < 1e-9);
  assert.equal(pts[5].kind, 'trade');
  // running balance
  assert.ok(Math.abs(pts[2].value - 103.05) < 1e-9);
  // no deltas -> just the start point
  assert.deepEqual(equityPoints(50, []).map((p) => p.i), [0]);
});

const LIVE_SAMPLE = {
  account: {
    login: 82406157, balance: 103.08, equity: 103.08, currency: 'GBP',
    timestamp: '2026.10.05 03:21:50',
  },
  deals: [
    { ticket: 239111125, position_id: 0, time: '2026.10.02 18:42:40', type: 2, entry: 0, volume: 0, profit: 100.0, commission: 0, swap: 0, comment: 'Deposit PB' },
    { ticket: 239122738, position_id: 0, time: '2026.10.02 19:39:11', type: 2, entry: 0, volume: 0, profit: 3.1, commission: 0, swap: 0, comment: 'Trf CLT 82372743 to 82406157' },
    { ticket: 239148519, position_id: 255104665, time: '2026.10.05 01:49:13', type: 1, entry: 0, volume: 0.01, price: 4147.59, profit: 0, commission: -0.05, swap: 0, comment: '' },
    { ticket: 239150157, position_id: 255104665, time: '2026.10.05 02:20:00', type: 0, entry: 1, volume: 0.01, price: 4146.53, profit: 0.8, commission: 0, swap: 0, comment: '[sl 4146.52]' },
    { ticket: 239152013, position_id: 255109587, time: '2026.10.05 03:02:20', type: 1, entry: 0, volume: 0.01, price: 4147.75, profit: 0, commission: -0.05, swap: 0, comment: '' },
    { ticket: 239152147, position_id: 255109587, time: '2026.10.05 03:04:07', type: 0, entry: 1, volume: 0.01, price: 4147.65, profit: -0.72, commission: 0, swap: 0, comment: '[sl 4147.58]' },
  ],
};

test('liveEquitySeries: pre-trade deposits fold into the starting balance', () => {
  const s = liveEquitySeries(LIVE_SAMPLE.account, LIVE_SAMPLE.deals, []);
  assert.equal(s.label, 'Deposit');
  assert.deepEqual(
    s.points.map((p) => [p.i, +p.value.toFixed(2), p.kind]),
    [[0, 103.10, 'start'], [1, 103.85, 'trade'], [2, 103.08, 'trade']],
  );
  assert.ok(Math.abs(s.end - LIVE_SAMPLE.account.balance) < 1e-9);
  assert.ok(Math.abs(s.points.at(-1).value - 103.08) < 1e-9);
});

test('liveEquitySeries: post-trade deposit folds at the next trade index', () => {
  const deals = [
    { ticket: 1, position_id: 0, time: '2026.10.01 09:00:00', type: 2, entry: 0, volume: 0, profit: 100, commission: 0, swap: 0 },
    // closed position 1: +10, closes 10:00
    { ticket: 2, position_id: 10, time: '2026.10.01 09:30:00', type: 0, entry: 0, volume: 0.01, price: 100, profit: 0, commission: 0, swap: 0 },
    { ticket: 3, position_id: 10, time: '2026.10.01 10:00:00', type: 1, entry: 1, volume: 0.01, price: 101, profit: 10, commission: 0, swap: 0 },
    // deposit mid-trading at 11:00, before position 2 closes at 12:00
    { ticket: 4, position_id: 0, time: '2026.10.01 11:00:00', type: 2, entry: 0, volume: 0, profit: 50, commission: 0, swap: 0 },
    { ticket: 5, position_id: 11, time: '2026.10.01 11:30:00', type: 0, entry: 0, volume: 0.01, price: 100, profit: 0, commission: 0, swap: 0 },
    { ticket: 6, position_id: 11, time: '2026.10.01 12:00:00', type: 1, entry: 1, volume: 0.01, price: 99, profit: -5, commission: 0, swap: 0 },
    // trailing deposit after the last close
    { ticket: 7, position_id: 0, time: '2026.10.01 13:00:00', type: 2, entry: 0, volume: 0, profit: 25, commission: 0, swap: 0 },
  ];
  const account = { balance: 100 + 10 + 50 - 5 + 25, timestamp: '2026.10.01 14:00:00' };
  const s = liveEquitySeries(account, deals, []);
  assert.equal(s.label, 'Deposit');
  assert.deepEqual(
    s.points.map((p) => [p.i, +p.value.toFixed(2), p.kind]),
    [
      [0, 100, 'start'],
      [1, 110, 'trade'],
      [2, 160, 'deposit'],   // +50 folds at the next trade's index
      [2, 155, 'trade'],
      [2, 180, 'deposit'],   // trailing deposit folds at the final index
    ],
  );
  assert.ok(Math.abs(s.end - account.balance) < 1e-9);
});

test('liveEquitySeries: open-position realised costs fold into the end', () => {
  const deals = [
    ...LIVE_SAMPLE.deals,
    { ticket: 8, position_id: 99, time: '2026.10.05 04:00:00', type: 1, entry: 0, volume: 0.01, price: 4150, profit: 0, commission: -0.05, swap: 0 },
  ];
  const openPositions = [
    { position_id: 99, ticket: 99, type: 'SELL', symbol: 'XAUUSD', volume: 0.01,
      price_open: 4150, time: '2026.10.05 04:00:00', profit: 0.3, sl: 0 },
  ];
  const account = { ...LIVE_SAMPLE.account, balance: 103.03 };
  const s = liveEquitySeries(account, deals, openPositions);
  // same indices — the open cost folds into the final point's value
  assert.deepEqual(s.points.map((p) => p.i), [0, 1, 2]);
  assert.ok(Math.abs(s.points.at(-1).value - 103.03) < 1e-9);
  assert.ok(Math.abs(s.end - account.balance) < 1e-9);
});

test('liveEquitySeries: carried-in balance labels Start, empty account Balance', () => {
  const s = liveEquitySeries(
    { ...LIVE_SAMPLE.account, balance: 200 }, LIVE_SAMPLE.deals, []);
  assert.equal(s.label, 'Start');
  assert.ok(Math.abs(s.points[0].value - (200 - 103.08 + 103.1)) < 1e-9); // carried + pre-deposits

  const empty = liveEquitySeries({ balance: 77, timestamp: '2026.10.05 00:00:00' }, [], []);
  assert.equal(empty.label, 'Balance');
  assert.deepEqual(empty.points, [{ i: 0, value: 77, kind: 'start' }]);
});

test('niceTicks: at most 5 ticks covering the range', () => {
  for (const [lo, hi] of [[99.7, 103.4], [0, 10], [1, 2], [-50.2, 10.4], [1000, 9999]]) {
    const ticks = niceTicks(lo, hi);
    assert.ok(ticks.length > 0 && ticks.length <= 5, `${lo}..${hi} -> ${ticks}`);
    assert.ok(ticks[0] >= lo - 1e-9 && ticks.at(-1) <= hi + 1e-9);
    const steps = new Set(ticks.slice(1).map((t, i) => +(t - ticks[i]).toFixed(9)));
    assert.equal(steps.size, 1); // evenly spaced
  }
  assert.deepEqual(niceTicks(5, 5), [5]);
});

test('manualBalanceEvents ignores open trades', () => {
  const trades = [
    { date: '2026-10-04T10:00', direction: 'LONG', entry: 100, exit: 105, size: 1, fees: 1 },
    { date: '2026-10-05T09:00', direction: 'LONG', entry: 100, exit: null, size: 1, fees: 0 },
    { date: '2026-10-05T11:00', direction: 'SHORT', entry: 50, exit: 48, size: 2, fees: 0 },
  ];
  const events = manualBalanceEvents(trades);
  assert.equal(events.length, 2);
  assert.ok(Math.abs(events[0].delta - 4) < 1e-9);
  assert.ok(Math.abs(events[1].delta - 4) < 1e-9);
});

test('setupLabel: strategy+zone derive, legacy fallback, empty', () => {
  assert.equal(setupLabel({ strategy: 'STC', zoneTf: 'M15', zone: 'Demand' }),
    'STC · M15 Demand');
  assert.equal(setupLabel({ strategy: 'STC' }), 'STC');
  assert.equal(setupLabel({ zoneTf: 'M15', zone: 'Demand' }), 'M15 Demand');
  assert.equal(setupLabel({ zone: 'Demand' }), 'Demand');
  assert.equal(setupLabel({ zoneTf: 'M15' }), 'M15');
  assert.equal(setupLabel({ setup: 'breakout' }), 'breakout');
  assert.equal(setupLabel({}), '');
});

test('bySetup: default key uses setupLabel with (none) fallback', () => {
  const rows = bySetup([
    { zoneTf: 'M15', zone: 'Demand', exit: 2, entry: 1, size: 1 },
    { zoneTf: 'M15', zone: 'Demand', exit: 0.5, entry: 1, size: 1 },
    { setup: 'breakout', exit: 2, entry: 1, size: 1 },
    { exit: 1, entry: 1, size: 1 },
  ]);
  const keys = rows.map((r) => r.setup);
  assert.equal(rows.filter((r) => r.setup === 'M15 Demand')[0].count, 2);
  assert.ok(keys.includes('breakout'));
  assert.ok(keys.includes('(none)'));
});

test('byGrade: groups by grade with (ungraded) fallback', () => {
  const rows = byGrade([
    { grade: 'A', exit: 2, entry: 1, size: 1 },
    { grade: 'A', exit: 0.5, entry: 1, size: 1 },
    { exit: 2, entry: 1, size: 1 },
  ]);
  assert.equal(rows.find((r) => r.setup === 'A').count, 2);
  assert.equal(rows.find((r) => r.setup === '(ungraded)').count, 1);
});

test('SETUP_FIELDS: eight names in order, strategy first', () => {
  assert.deepEqual(SETUP_FIELDS.map((f) => f.name),
    ['strategy', 'zone', 'zoneTf', 'grade', 'session', 'h1', 'tap', 'review']);
  for (const f of SETUP_FIELDS) assert.ok(f.options.length >= 1, f.name);
});

test('dayKey: live closeTime, manual date, junk and empty', () => {
  assert.equal(dayKey({ source: 'live', closeTime: '2026-10-07T23:08:00' }), '2026-10-07');
  assert.equal(dayKey({ date: '2026-10-06T09:30' }), '2026-10-06');
  assert.equal(dayKey({ source: 'live', openTime: '2026-10-05T08:00:00' }), '2026-10-05');
  assert.equal(dayKey({ date: 'not a date' }), '');
  assert.equal(dayKey({}), '');
});

test('groupByDay: newest day first, undated last, per-day stats', () => {
  const rows = [
    { source: 'live', status: 'CLOSED', closeTime: '2026-10-06T10:00:00', net: 5 },
    { source: 'live', status: 'CLOSED', closeTime: '2026-10-07T08:00:00', net: -3 },
    { source: 'live', status: 'OPEN',   openTime:  '2026-10-07T09:00:00', net: 2, floating: 2 },
    { source: 'live', status: 'CLOSED', closeTime: '2026-10-07T11:00:00', net: 10 },
    { source: 'live', status: 'CLOSED', closeTime: '2026-10-06T12:00:00', net: 0 },
    { notes: 'undated' },
  ];
  const groups = groupByDay(rows);
  assert.deepEqual(groups.map((g) => g.key), ['2026-10-07', '2026-10-06', '']);

  const d7 = groups[0];
  assert.deepEqual([d7.closed, d7.wins, d7.losses, d7.open], [2, 1, 1, 1]);
  assert.equal(d7.net, 7);                      // closed only; open row's floating excluded
  assert.deepEqual(d7.trades.map((t) => t.net), [-3, 2, 10]); // input order kept

  const d6 = groups[1];
  assert.deepEqual([d6.closed, d6.wins, d6.losses, d6.open], [2, 1, 0, 0]);
  assert.equal(d6.net, 5);

  const undated = groups[2];
  assert.deepEqual([undated.closed, undated.open], [0, 1]);
});

test('dayLabel: weekday format, year suffix outside current year, Undated', () => {
  const now = new Date(2026, 9, 20);
  assert.equal(dayLabel('2026-10-07', { now, locale: 'en-GB' }), 'Wed 7 Oct');
  assert.equal(dayLabel('2025-12-31', { now, locale: 'en-GB' }), 'Wed 31 Dec 2025');
  assert.equal(dayLabel(''), 'Undated');
});

const EPS = (a, b) => Math.abs(a - b) < 1e-9;

test('weekKey: ISO week Monday', () => {
  assert.equal(weekKey('2026-10-07'), '2026-10-05'); // Wed -> Mon
  assert.equal(weekKey('2026-10-11'), '2026-10-05'); // Sunday belongs to that week
  assert.equal(weekKey('2026-10-12'), '2026-10-12'); // next Monday
  assert.equal(weekKey('junk'), '');
});

test('riskStatus: fresh day inside the same week', () => {
  const pts = equityPoints(100, [{ delta: -5, time: '2026-10-05T10:00' }]);
  const s = riskStatus(pts, { dailyPct: 10, weeklyPct: 23 },
    { today: '2026-10-06', equity: 95 });
  assert.ok(EPS(s.daily.periodStart, 95) && EPS(s.daily.allowance, 9.5)
    && EPS(s.daily.level, 85.5) && EPS(s.daily.left, 9.5)
    && EPS(s.daily.used, 0));
  assert.ok(EPS(s.weekly.periodStart, 100) && EPS(s.weekly.allowance, 23)
    && EPS(s.weekly.level, 77) && EPS(s.weekly.left, 18)
    && EPS(s.weekly.used, 5 / 23));
});

test('riskStatus: same-day trailing measured against live equity', () => {
  const pts = equityPoints(100, [
    { delta: 10, time: '2026-10-05T10:00' },
    { delta: -4, time: '2026-10-05T12:00' },
  ]);
  const s = riskStatus(pts, { dailyPct: 10, weeklyPct: null },
    { today: '2026-10-05', equity: 104 });
  assert.ok(EPS(s.daily.periodStart, 100) && EPS(s.daily.allowance, 10)
    && EPS(s.daily.level, 100) && EPS(s.daily.left, 4)
    && EPS(s.daily.used, 0.6));
  assert.ok(EPS(s.highest, 110) && EPS(s.lowest, 100));
});

test('riskStatus: under the level goes negative, then keeps trailing', () => {
  const pts = equityPoints(100, [{ delta: -12, time: '2026-10-05T10:00' }]);
  let s = riskStatus(pts, { dailyPct: 10, weeklyPct: null },
    { today: '2026-10-05', equity: 88 });
  assert.ok(EPS(s.daily.level, 90) && EPS(s.daily.left, -2)
    && EPS(s.daily.used, 1));

  // a later close above the day peak moves the level up — no freeze
  const pts2 = [...pts, { i: 2, value: 103, kind: 'trade', delta: 15,
    time: '2026-10-05T12:00' }];
  s = riskStatus(pts2, { dailyPct: 10, weeklyPct: null },
    { today: '2026-10-05', equity: 103 });
  assert.ok(EPS(s.daily.periodStart, 100) && EPS(s.daily.allowance, 10)
    && EPS(s.daily.level, 93) && EPS(s.daily.left, 10)
    && EPS(s.daily.used, 0));
  // 100 -> 88 -> 103: the range tracks the full path, not just the ends
  assert.ok(EPS(s.highest, 103) && EPS(s.lowest, 88));
});

test('riskStatus: a new ISO week starts the weekly rule fresh', () => {
  const pts = equityPoints(100, [{ delta: -30, time: '2026-10-07T10:00' }]);
  const s = riskStatus(pts, { dailyPct: null, weeklyPct: 23 },
    { today: '2026-10-13', equity: 70 });
  assert.ok(EPS(s.weekly.periodStart, 70) && EPS(s.weekly.allowance, 16.1)
    && EPS(s.weekly.level, 53.9) && EPS(s.weekly.left, 16.1)
    && EPS(s.weekly.used, 0));
});

test('riskStatus: defaults — equity falls back to balance, unset pct is null', () => {
  const pts = equityPoints(100, [{ delta: -5, time: '2026-10-05T10:00' }]);
  const s = riskStatus(pts, { dailyPct: null, weeklyPct: 23 },
    { today: '' });                    // no today -> current period from state
  assert.equal(s.daily, null);
  assert.equal(s.equity, 95);          // equity omitted -> balance
  assert.ok(EPS(s.weekly.periodStart, 100) && EPS(s.weekly.level, 77)
    && EPS(s.weekly.left, 18) && EPS(s.weekly.used, 5 / 23));
});

test('summarize: commission and swap totals over closed live rows', () => {
  const s = summarize([
    { source: 'live', status: 'CLOSED', closeTime: '2026-10-05T10:00:00',
      net: 2, commission: -0.30, swap: 0 },
    { source: 'live', status: 'CLOSED', closeTime: '2026-10-05T12:00:00',
      net: -1, commission: -0.45, swap: -0.12 },
    { source: 'live', status: 'OPEN', openTime: '2026-10-05T13:00:00',
      net: 0, commission: -0.15, swap: 0, floating: 0 },
  ]);
  assert.ok(EPS(s.commission, -0.75) && EPS(s.swap, -0.12),
    `${s.commission} / ${s.swap}`);
  assert.equal(s.hasSwap, true);
});

test('summarize: manual fees become negative commission, no swap', () => {
  const s = summarize([
    { date: '2026-10-05T10:00', entry: 1, exit: 2, size: 1, fees: 1.5 },
    { date: '2026-10-05T12:00', entry: 1, exit: 0.5, size: 1, fees: 2 },
  ]);
  assert.ok(EPS(s.commission, -3.5) && EPS(s.swap, 0),
    `${s.commission} / ${s.swap}`);
  assert.equal(s.hasSwap, false);
});

test('monthGrid: Monday-first 42 cells covering the month', () => {
  const oct = monthGrid(2026, 10);
  assert.equal(oct.length, 42);
  assert.equal(oct[0].key, '2026-09-28'); // Oct 1 2026 is a Thursday
  assert.deepEqual(oct[3], { key: '2026-10-01', day: 1, inMonth: true });
  assert.equal(oct[33].key, '2026-10-31');
  assert.equal(oct[34].inMonth, false);
  const jun = monthGrid(2026, 6);
  assert.equal(jun[0].key, '2026-06-01'); // June 1 2026 is a Monday
});

test('dayState: future > unknown > win/loss/flat > none', () => {
  const opts = { today: '2026-10-08', earliest: '2026-10-05' };
  const day = '2026-10-06';
  assert.equal(dayState({ closed: 2, net: 10 }, day, opts), 'win');
  assert.equal(dayState({ closed: 2, net: -5 }, day, opts), 'loss');
  assert.equal(dayState({ closed: 2, net: 0 }, day, opts), 'flat');
  assert.equal(dayState({ closed: 0, net: 3 }, day, opts), 'none'); // open only
  assert.equal(dayState(null, day, opts), 'none');
  assert.equal(dayState({ closed: 1, net: 9 }, '2026-10-09', opts), 'future');
  assert.equal(dayState({ closed: 1, net: 9 }, '2026-10-04', opts), 'unknown');
  // future wins over unknown when both would apply
  assert.equal(
    dayState({ closed: 1, net: 9 }, '2030-01-01',
      { today: '2026-10-08', earliest: '2030-06-01' }),
    'future');
});
