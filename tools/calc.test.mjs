// Unit tests for the equity-curve math. Run: node --test 'tools/**/*.test.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';

import { equityPoints, manualBalanceEvents, niceTicks, summarize,
  setupLabel, bySetup, byGrade, SETUP_FIELDS,
  dayKey, groupByDay, dayLabel, weekKey, riskStatus,
  monthGrid, dayState, shiftDay, shiftMonth, weekDays, weekTitle,
  countResults, summaryText, byHour, flagReentries,
  ordinal, bySetupClass, heldThroughStop } from '../calc.js';
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

test('shiftDay / shiftMonth move day keys', () => {
  assert.equal(shiftDay('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftDay('2026-10-05', -7), '2026-09-28');
  assert.equal(shiftMonth('2026-10-31', 1), '2026-11-30'); // clamps to month end
  assert.equal(shiftMonth('2026-01-15', -1), '2025-12-15');
});

test('weekDays: 7 cells from the Monday', () => {
  const days = weekDays('2026-10-05');
  assert.equal(days.length, 7);
  assert.equal(days[0].key, '2026-10-05');
  assert.equal(days[6].key, '2026-10-11');
  assert.equal(days[0].dow, 0);
  assert.equal(days[6].dow, 6);
});

test('weekTitle: month/year shown once unless the week spans them', () => {
  const en = { locale: 'en-GB' };
  assert.equal(weekTitle('2026-10-05', en), '5 – 11 Oct 2026');
  assert.equal(weekTitle('2026-09-28', en), '28 Sep – 4 Oct 2026');
  assert.equal(weekTitle('2025-12-29', en), '29 Dec 2025 – 4 Jan 2026');
});

test('countResults / summaryText', () => {
  assert.deepEqual(
    countResults([5, -3, 0].map((n) => ({ n })), (x) => x.n),
    { total: 3, red: 1, green: 1 });
  assert.equal(summaryText({ total: 4, red: 2, green: 2 }), '4/2r/2g');
  assert.equal(summaryText({ total: 0, red: 0, green: 0 }), '0/0r/0g');
});

test('summarize: expectancy = mean net ± standard error', () => {
  const s = summarize([
    { date: '2026-10-05T10:00', entry: 1, exit: 2, size: 10 },   // +10
    { date: '2026-10-05T11:00', entry: 1, exit: 0.5, size: 10 }, // -5
    { date: '2026-10-05T12:00', entry: 1, exit: 1.5, size: 10 }, // +5
  ]);
  assert.ok(Math.abs(s.expectancy.mean - 10 / 3) < 1e-9);
  assert.ok(Math.abs(s.expectancy.se - 4.4096) < 1e-3,
    `se ${s.expectancy.se}`);
  assert.equal(s.expectancy.n, 3);
  const one = summarize([
    { date: '2026-10-05T10:00', entry: 1, exit: 2, size: 10 }]);
  assert.equal(one.expectancy.n, 1);
  assert.equal(one.expectancy.se, null); // n-1 undefined for a single trade
});

test('summarize: excursion averages over measured closed rows only', () => {
  const s = summarize([
    { source: 'live', status: 'CLOSED', net: 5,
      mfe_pts: 8, mae_pts: 3, capture: 0.5 },
    { source: 'live', status: 'CLOSED', net: -2,
      mfe_pts: 4, mae_pts: 5, capture: null },
    { source: 'live', status: 'CLOSED', net: 1 },      // unmeasured
    { source: 'live', status: 'OPEN' },                // not closed
  ]);
  assert.equal(s.excursion.n, 2);
  assert.ok(EPS(s.excursion.avgMfe, 6) && EPS(s.excursion.avgMae, 4));
  assert.equal(s.excursion.nCapture, 1);
  assert.ok(EPS(s.excursion.avgCapture, 0.5));
  const none = summarize([{ source: 'live', status: 'CLOSED', net: 1 }]);
  assert.equal(none.excursion.n, 0);
  assert.equal(none.excursion.avgMfe, null);
});

test('bySetup: avgR is the mean R of rows carrying a stop', () => {
  const rows = bySetup([
    { setup: 'brk', entry: 100, exit: 110, size: 1, stopLoss: 95 }, // R 2
    { setup: 'brk', entry: 100, exit: 105, size: 1, stopLoss: 95 }, // R 1
    { setup: 'brk', entry: 100, exit: 90, size: 1 },              // no stop
    { setup: 'other', entry: 1, exit: 2, size: 1 },               // no stop
  ]);
  assert.equal(rows.find((r) => r.setup === 'brk').avgR, 1.5);
  assert.equal(rows.find((r) => r.setup === 'other').avgR, null);
});

test('byHour buckets closed net by entry hour, 24 slots', () => {
  const mk = (open, net, status = 'CLOSED') => ({
    source: 'live', openTime: open, closeTime: open, status, net });
  const hours = byHour([
    mk('2026-10-05T09:15:00', 5),
    mk('2026-10-05T09:40:00', -2),
    mk('2026-10-06T14:05:00', 1),
    mk('2026-10-05T09:50:00', 9, 'OPEN'),          // open — excluded
    { source: 'live', status: 'CLOSED', net: 3,
      openTime: 'not-a-time', closeTime: 'x' },   // unparseable — skipped
  ]);
  assert.equal(hours.length, 24);
  assert.deepEqual(hours[9],
    { hour: 9, count: 2, wins: 1, losses: 1, net: 3 });
  assert.equal(hours[14].count, 1);
  assert.equal(hours.filter((b) => b.count === 0).length, 22);
});

test('flagReentries flags opens within the window after a losing close', () => {
  const mk = (open, close, net, status = 'CLOSED') => ({
    source: 'live', openTime: open, closeTime: close, status, net });
  const A = mk('2026-10-05T09:50:00', '2026-10-05T10:00:00', -10);
  const B = mk('2026-10-05T10:03:00', '2026-10-05T10:06:00', 4);
  const C = mk('2026-10-05T10:08:00', '2026-10-05T10:12:00', 4);
  const W = mk('2026-10-05T10:25:00', '2026-10-05T10:30:00', 20);
  const D = mk('2026-10-05T10:31:00', '2026-10-05T10:35:00', 3);
  const E = mk('2026-10-05T09:58:00', '2026-10-05T10:02:00', 2);
  const O = mk('2026-10-05T10:04:30', null, 0, 'OPEN');
  const rows = [A, B, C, W, D, E, O];
  const map = flagReentries(rows, 5);
  assert.equal(map.size, 2);                      // B and the open O
  const f = map.get(B);
  assert.equal(f.gapMin, 3);
  assert.equal(f.prevNet, -10);
  assert.equal(map.get(O).gapMin, 4.5);           // any status can flag
  assert.ok(!map.has(C));                         // 8m > 5m window
  assert.ok(!map.has(D));                         // latest loss is 31m back
  assert.ok(!map.has(E));                         // opened before A closed
  assert.ok(!map.has(A));                         // never its own predecessor
  assert.equal(flagReentries(rows, 0).size, 0);
  assert.equal(flagReentries(rows, null).size, 0);
});

test('flagReentries manual rows: date is both open and close', () => {
  const man = (date, exit) => ({
    source: 'manual', direction: 'LONG',
    entry: 1, exit, size: 100, date });
  const mL = man('2026-10-05T10:00', 0.5);        // loss: -50
  const mB = man('2026-10-05T10:03', 2);          // win, 3m later
  const map = flagReentries([mL, mB], 5);
  assert.ok(map.has(mB));
  assert.equal(map.get(mB).gapMin, 3);
  assert.equal(map.get(mB).prevNet, -50);
  assert.ok(!map.has(mL));                        // a manual loss can't flag itself
});

test('ordinal: 1st/2nd/3rd/4th, teens th, 21/22/23, null for junk', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th',
     '21st', '22nd', '23rd', '101st']);
  assert.equal(ordinal(0), null);
  assert.equal(ordinal(1.5), null);
  assert.equal(ordinal(null), null);
});

test('bySetupClass: fixed order, buckets, manual rows -> no setup', () => {
  const live = (cls, net, extra = {}) => ({
    source: 'live', status: 'CLOSED', closeTime: '2026-10-05T10:00:00',
    setup_class: cls, net, ...extra });
  const rows = bySetupClass([
    live('wanted', 4), live('wanted', -2),
    live('other', 5),
    live('avoid', -3), live('avoid', -1), live('avoid', 2),
    live('none', 1),
    live(null, 7),                                    // no platform class
    { source: 'manual', entry: 1, exit: 2, size: 1,
      date: '2026-10-05T09:00' },                     // manual win: +1
    live('wanted', 99, { status: 'OPEN' }),           // open — excluded
  ]);
  assert.deepEqual(rows.map((r) => r.setup),
    ['wanted', 'other setup', 'avoid set', 'no setup']);
  const [wanted, other, avoid, none] = rows;
  assert.deepEqual(
    [wanted.count, wanted.wins, wanted.net], [2, 1, 2]);
  assert.deepEqual([other.count, other.wins, other.net], [1, 1, 5]);
  assert.deepEqual([avoid.count, avoid.wins, avoid.net], [3, 1, -2]);
  // none(1) + no-class(7) + manual(1) = 9 net over 3 rows
  assert.deepEqual([none.count, none.wins, none.net], [3, 3, 9]);
});

test('bySetupClass: empty input still returns the four rows at n=0', () => {
  const rows = bySetupClass([]);
  assert.deepEqual(rows.map((r) => r.setup),
    ['wanted', 'other setup', 'avoid set', 'no setup']);
  assert.ok(rows.every((r) => r.count === 0 && r.wins === 0 && r.net === 0));
});

test('heldThroughStop: counts closed live rows held through invalidation', () => {
  const live = (exit, net, status = 'CLOSED') => ({
    source: 'live', status, closeTime: '2026-10-05T10:00:00',
    exit_vs_setup: exit, net });
  const h = heldThroughStop([
    live('held_through_invalidation', -5),
    live('held_through_invalidation', -3.5),
    live('before_target', 10),
    live('n/a', 1),
    live('held_through_invalidation', -9, 'OPEN'),   // open — excluded
    { source: 'manual', entry: 1, exit: 0.5, size: 1,
      date: '2026-10-05T09:00',
      exit_vs_setup: 'held_through_invalidation' },  // manual — no flag
  ]);
  assert.deepEqual(h, { n: 2, net: -8.5 });
  assert.deepEqual(heldThroughStop([]), { n: 0, net: null });
  assert.deepEqual(heldThroughStop([live('n/a', 1)]), { n: 0, net: null });
});
