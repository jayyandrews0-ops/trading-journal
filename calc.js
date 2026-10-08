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
// the balance after the i-th closed trade in time order.
export function equityPoints(startBalance, deltas) {
  const points = [{ i: 0, value: startBalance, kind: 'start' }];
  let acc = startBalance;
  (deltas || []).forEach((delta, k) => {
    acc += delta;
    points.push({ i: k + 1, value: acc, kind: 'trade', delta });
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

// Derived setup label from the dropdown fields ("M15 Demand"), falling
// back to a legacy free-text setup so older records still display.
export function setupLabel(t) {
  const derived = [t.zoneTf, t.zone].filter(Boolean).join(' ');
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
