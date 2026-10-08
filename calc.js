// Pure trade math — nothing here touches the DOM or IndexedDB.

export function directionSign(trade) {
  return trade.direction === 'SHORT' ? -1 : 1;
}

// Net P&L: (exit - entry) * size * dir - fees. null when the trade is open.
export function pnl(trade) {
  if (trade.exit == null || trade.entry == null || trade.size == null) return null;
  return (trade.exit - trade.entry) * trade.size * directionSign(trade) - (trade.fees || 0);
}

export function riskPerUnit(trade) {
  const stop = trade.stopLoss ?? trade.sl; // manual stopLoss, live sl, or annotation stopLoss
  if (stop == null || trade.entry == null) return null;
  const r = Math.abs(trade.entry - stop);
  return r > 0 ? r : null;
}

// R multiple: price move in R units (size/fees excluded by convention).
export function rMultiple(trade) {
  const risk = riskPerUnit(trade);
  if (risk == null || trade.exit == null || trade.entry == null) return null;
  return ((trade.exit - trade.entry) * directionSign(trade)) / risk;
}

export function outcome(trade) {
  const p = tradeNet(trade);
  if (!isClosed(trade) || p == null) return 'OPEN';
  if (p > 0) return 'WIN';
  if (p < 0) return 'LOSS';
  return 'BE';
}

export function isClosed(trade) {
  return trade.source === 'live' ? trade.status === 'CLOSED' : trade.exit != null;
}

// Net result of a row: live positions carry precomputed net (incl. costs).
export function tradeNet(t) {
  return t.source === 'live' ? (t.net ?? 0) : pnl(t);
}

// Sort/display timestamp: live uses broker closeTime/openTime, manual uses date.
export function tradeTime(t) {
  return t.closeTime || t.date || t.openTime || '';
}

// ROI as a fraction (0.1 = 10%); null unless startingBalance is finite and > 0.
export function roi(net, startingBalance) {
  if (typeof startingBalance !== 'number' || !isFinite(startingBalance) || startingBalance <= 0) return null;
  return net / startingBalance;
}

// Aggregate stats over closed trades only.
export function summarize(trades) {
  const closed = trades.filter(isClosed);
  const pnls = closed.map((t) => ({ t, p: tradeNet(t) ?? 0 }));
  let commission = 0, swap = 0, hasSwap = false;
  for (const t of closed) {
    if (t.source === 'live') {
      commission += t.commission || 0;   // MT5 signs: costs are negative
      swap += t.swap || 0;
      hasSwap = true;
    } else {
      commission -= t.fees || 0;         // manual fees are entered positive
    }
  }
  const wins = pnls.filter((x) => x.p > 0);
  const losses = pnls.filter((x) => x.p < 0);
  const grossWins = wins.reduce((s, x) => s + x.p, 0);
  const grossLosses = Math.abs(losses.reduce((s, x) => s + x.p, 0));
  const net = grossWins - grossLosses;

  const rs = closed.map(rMultiple).filter((r) => r != null);
  const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

  let best = null, worst = null;
  for (const x of pnls) {
    if (!best || x.p > best.p) best = x;
    if (!worst || x.p < worst.p) worst = x;
  }

  // Current streak: walk newest -> oldest until the sign changes.
  const byDateDesc = [...closed].sort((a, b) => tradeTime(b).localeCompare(tradeTime(a)));
  let streak = 0, streakType = null;
  for (const t of byDateDesc) {
    const p = tradeNet(t) ?? 0;
    const type = p > 0 ? 'WIN' : p < 0 ? 'LOSS' : 'BE';
    if (streakType === null) { streakType = type; streak = 1; }
    else if (type === streakType) streak++;
    else break;
  }

  return {
    total: trades.length,
    closed: closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    net,
    avgR,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : null),
    best: best ? { trade: best.t, pnl: best.p } : null,
    worst: worst ? { trade: worst.t, pnl: worst.p } : null,
    streak: streakType ? { count: streak, type: streakType } : null,
    commission,
    swap,
    hasSwap,
  };
}

// Cumulative net P&L series, trades ordered by date ascending.
export function equitySeries(trades) {
  const closed = trades.filter(isClosed)
    .sort((a, b) => tradeTime(a).localeCompare(tradeTime(b)));
  let acc = 0;
  return closed.map((t) => { acc += tradeNet(t) ?? 0; return { date: tradeTime(t), value: acc }; });
}

/* ---------- balance curve ---------- */

// Balance events are { time, delta, kind } — time a sortable string
// ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS'), kind 'trade' | 'cost' | 'balance'.

// Closed-trade balance events for the manual journal.
export function manualBalanceEvents(trades) {
  return trades.filter(isClosed)
    .map((t) => ({ time: tradeTime(t), delta: tradeNet(t) ?? 0, kind: 'trade' }));
}

// Classic equity-curve points: index 0 is the starting balance, index i is
// the balance after the i-th event in time order. Events are { delta, time }
// (what manualBalanceEvents produces); `time` is carried onto the point so
// risk lines can key days/weeks.
export function equityPoints(startBalance, events) {
  const points = [{ i: 0, value: startBalance, kind: 'start' }];
  let acc = startBalance;
  (events || []).forEach((e, k) => {
    acc += e.delta;
    const p = { i: k + 1, value: acc, kind: 'trade', delta: e.delta };
    if (e.time !== undefined) p.time = e.time;
    points.push(p);
  });
  return points;
}

// "Nice" tick values covering [min, max]: the smallest 1/2/5 × 10^k step
// that yields at most 5 ticks.
export function niceTicks(min, max) {
  if (!(isFinite(min) && isFinite(max))) return [];
  if (min === max) return [min];
  const span = max - min;
  let pow = Math.pow(10, Math.floor(Math.log10(span)));
  for (;;) {
    for (const m of [1, 2, 5]) {
      const step = m * pow;
      const ticks = [];
      for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) {
        ticks.push(+v.toFixed(12));
      }
      if (ticks.length <= 5) return ticks;
    }
    pow *= 10;
  }
}

// Label step for trade-index x ticks: every trade when N ≤ 10, else the
// smallest nice step (5/10/20/25/50 × 10^k) giving at most 6 labels.
export function indexStep(n) {
  if (n <= 10) return 1;
  let pow = 1;
  for (;;) {
    for (const m of [5, 10, 20, 25, 50]) {
      const step = m * pow;
      if (Math.floor(n / step) <= 5) return step;
    }
    pow *= 10;
  }
}

/* ---------- setup descriptors ---------- */

// The dropdown fields on the trade form, in display order. Option labels
// are stored as-is (display strings); users can extend every list from
// the "＋ Add new…" item in the form.
export const SETUP_FIELDS = [
  { name: 'strategy', label: 'Strategy', options: ['STC'] },
  { name: 'zone',    label: 'Zone',      options: ['Supply', 'Demand'] },
  { name: 'zoneTf',  label: 'Timeframe', options: ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] },
  { name: 'grade',   label: 'Grade',     options: ['A++', 'A+', 'A', 'B', 'C'] },
  { name: 'session', label: 'Session',   options: ['Asia', 'London', 'New York'] },
  { name: 'h1',      label: 'H1',        options: ['With H1', 'Against H1'] },
  { name: 'tap',     label: 'Tap',       options: ['1st', '2nd', '3rd', '4th+'] },
  { name: 'review',  label: 'Review',    options: [
    'Followed plan', 'Early entry', 'Late entry', 'Moved SL',
    'Held through invalidation', 'Closed early', 'Oversized',
    'Revenge / FOMO', 'No setup',
  ] },
];

// Derived setup label from the dropdown fields ("STC · M15 Demand"),
// falling back to a legacy free-text setup so older records still display.
export function setupLabel(t) {
  const zone = [t.zoneTf, t.zone].filter(Boolean).join(' ');
  const derived = [t.strategy, zone].filter(Boolean).join(' · ');
  return derived || (t.setup || '').trim();
}

export function bySetup(trades, keyOf = (t) => setupLabel(t) || '(none)') {
  const map = new Map();
  for (const t of trades.filter(isClosed)) {
    const key = keyOf(t);
    const p = tradeNet(t) ?? 0;
    const row = map.get(key) || { setup: key, count: 0, wins: 0, net: 0 };
    row.count++;
    if (p > 0) row.wins++;
    row.net += p;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.net - a.net);
}

export function byGrade(trades) {
  return bySetup(trades, (t) => t.grade || '(ungraded)');
}

/* ---------- day grouping ---------- */

// Wall-clock day key from the row's sort timestamp — a plain string slice,
// never a Date conversion (broker day vs phone day may differ near
// midnight; slicing keeps whatever clock the row carries).
export function dayKey(t) {
  const key = String(tradeTime(t)).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : '';
}

// Groups rows into days, newest first; the undated ('') group comes last.
// Input order is preserved within each group. `net` sums closed rows only —
// an open row's floating P&L changes with every tick and would go stale in
// a header.
export function groupByDay(trades) {
  const map = new Map();
  for (const t of trades) {
    const key = dayKey(t);
    let g = map.get(key);
    if (!g) {
      g = { key, trades: [], closed: 0, wins: 0, losses: 0, open: 0, net: 0 };
      map.set(key, g);
    }
    g.trades.push(t);
    if (isClosed(t)) {
      g.closed++;
      const p = tradeNet(t) ?? 0;
      g.net += p;
      if (p > 0) g.wins++;
      else if (p < 0) g.losses++;
    } else {
      g.open++;
    }
  }
  const keys = [...map.keys()].filter((k) => k !== '').sort().reverse();
  if (map.has('')) keys.push('');
  return keys.map((k) => map.get(k));
}

// "Wed 7 Oct" (+ " 2025" when the day is not in the current year).
// Explicit dates only — no Today/Yesterday, since broker and phone days
// can differ near midnight.
export function dayLabel(key, { now = new Date(), locale } = {}) {
  if (!key) return 'Undated';
  const [y, m, d] = key.split('-').map(Number);
  const label = new Intl.DateTimeFormat(
    locale, { weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(y, m - 1, d));
  return y === now.getFullYear() ? label : `${label} ${y}`;
}

/* ---------- funded-account risk lines ---------- */

// Monday of the ISO week containing day 'YYYY-MM-DD' (local constructor, no
// UTC). '' for invalid input.
export function weekKey(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7); // getDay: Sun=0 -> Mon=0
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Loss limits, for the drawdown panel.
//   daily:  pct% below the running DAY peak (trails, resets each broker day)
//   weekly: pct% below the WEEK's starting balance (fixed, resets Monday)
// Walks the closed-trade points once, tracking the period anchors for one
// rule. Resets derive from the previous point's value; deposits shift the
// anchors with the money. The daily peak trails every close — there is no
// freeze: these are the user's own limits, a close under the level changes
// nothing about how the level is computed.
function walkRisk(points, pct, kind) {
  const state = { periodStart: 0, allowance: 0, peak: 0, period: null };
  if (!(typeof pct === 'number' && isFinite(pct) && pct > 0)) return state;

  const keyOf = (p) => {
    const day = String(p.time || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    return kind === 'daily' ? day : weekKey(day);
  };

  const start = points[0].value;
  state.periodStart = start;
  state.allowance = pct / 100 * start;
  state.peak = start;

  for (let j = 1; j < points.length; j++) {
    const p = points[j];
    const key = keyOf(p);
    if (key !== null && key !== state.period) {
      // The first dated point only adopts its period; a reset happens when
      // an already-established period key changes.
      const reset = state.period !== null;
      state.period = key;
      if (reset) {
        state.periodStart = points[j - 1].value;
        state.allowance = pct / 100 * state.periodStart;
        state.peak = state.periodStart;
      }
    }
    if (p.kind === 'deposit') {
      state.periodStart += p.delta;
      state.peak += p.delta;
    } else if (kind === 'daily') {
      state.peak = Math.max(state.peak, p.value);
    }
  }
  return state;
}

// Where the rules stand NOW: the closed-history state continued into the
// current period, measured against live equity. When today has rolled past
// the last closed trade's period the rule starts fresh from the balance —
// the reset happened even though nothing was written. `left` may go
// negative: it is room remaining, not a breach flag.
export function riskStatus(points, { dailyPct, weeklyPct } = {},
                           { today, equity } = {}) {
  const balance = points.length ? points[points.length - 1].value : 0;
  const eq = Number.isFinite(equity) ? equity : balance;
  // Full closed-balance range over the loaded history (start included).
  let highest = 0, lowest = 0;
  if (points.length) {
    highest = lowest = points[0].value;
    for (const p of points) {
      if (p.value > highest) highest = p.value;
      if (p.value < lowest) lowest = p.value;
    }
  }

  const status = (kind, pct) => {
    if (!(typeof pct === 'number' && isFinite(pct) && pct > 0)) return null;
    const state = walkRisk(points, pct, kind);
    const key = today ? (kind === 'daily' ? today : weekKey(today)) : '';
    let periodStart, allowance, level;
    if (key && (state.period === null || state.period !== key)) {
      periodStart = balance;
      allowance = pct / 100 * periodStart;
      level = periodStart - allowance;
    } else {
      periodStart = state.periodStart;
      allowance = state.allowance;
      level = (kind === 'daily' ? state.peak : state.periodStart) - allowance;
    }
    const left = eq - level;
    // Snap float dust to 0 so sitting exactly on the peak reads as no usage.
    const raw = (allowance - left) / allowance;
    const used = raw < 1e-6 ? 0 : Math.min(1, raw);
    return { pct, periodStart, allowance, level, left, used };
  };

  return {
    balance,
    equity: eq,
    highest,
    lowest,
    daily: status('daily', dailyPct),
    weekly: status('weekly', weeklyPct),
  };
}

/* ---------- calendar ---------- */

// 42 Monday-first cells covering the month: { key: 'YYYY-MM-DD', day, inMonth }.
export function monthGrid(year, month) {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() + 6) % 7; // weekday of the 1st, 0 = Monday
  const start = new Date(year, month - 1, 1 - lead);
  const pad = (n) => String(n).padStart(2, '0');
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(
      start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      day: d.getDate(),
      inMonth: d.getMonth() === month - 1,
    });
  }
  return cells;
}

// Colour of one calendar day: future > unknown (before the data window) >
// win/loss/flat (has closed rows) > none.
export function dayState(group, key, { today, earliest } = {}) {
  if (today && key > today) return 'future';
  if (earliest && key < earliest) return 'unknown';
  if (!group || group.closed === 0) return 'none';
  if (group.net > 0) return 'win';
  if (group.net < 0) return 'loss';
  return 'flat';
}

function parseDayKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function formatDayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function shiftDay(key, days) {
  const d = parseDayKey(key);
  if (!d) return String(key);
  d.setDate(d.getDate() + days);
  return formatDayKey(d);
}

// Same day-of-month, clamped to the target month's length.
export function shiftMonth(key, months) {
  const d = parseDayKey(key);
  if (!d) return String(key);
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(
    target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return formatDayKey(target);
}

// The 7 cells of a week starting on its Monday key: { key, day, dow 0..6 }.
export function weekDays(mondayKey) {
  const days = [];
  for (let dow = 0; dow < 7; dow++) {
    const key = shiftDay(mondayKey, dow);
    days.push({ key, day: +key.slice(8, 10), dow });
  }
  return days;
}

// "5 – 11 Oct 2026"; month/year appear once unless the week spans them.
// Month name via Intl ("Sept" normalised to "Sep").
export function weekTitle(mondayKey, { locale } = {}) {
  const start = parseDayKey(mondayKey);
  if (!start) return '';
  const end = new Date(
    start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const mon = (d) =>
    new Intl.DateTimeFormat(locale, { month: 'short' })
      .format(d).replace(/^Sept$/, 'Sep');
  const sameMonth = start.getMonth() === end.getMonth();
  const sameYear = start.getFullYear() === end.getFullYear();
  const a = `${start.getDate()}`
    + (sameMonth ? '' : ` ${mon(start)}`)
    + (sameYear ? '' : ` ${start.getFullYear()}`);
  const b = `${end.getDate()} ${mon(end)} ${end.getFullYear()}`;
  return `${a} – ${b}`;
}

// Result tallies for the `N/Rr/Gg` summary: total counts every item with a
// result; net 0 counts in total only.
export function countResults(items, netOf) {
  let total = 0, red = 0, green = 0;
  for (const it of items) {
    const n = netOf(it);
    if (n == null) continue;
    total += 1;
    if (n < 0) red += 1;
    else if (n > 0) green += 1;
  }
  return { total, red, green };
}

export function summaryText({ total, red, green }) {
  return `${total}/${red}r/${green}g`;
}
