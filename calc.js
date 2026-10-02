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

export function bySetup(trades) {
  const map = new Map();
  for (const t of trades.filter(isClosed)) {
    const key = (t.setup || '').trim() || '(none)';
    const p = tradeNet(t) ?? 0;
    const row = map.get(key) || { setup: key, count: 0, wins: 0, net: 0 };
    row.count++;
    if (p > 0) row.wins++;
    row.net += p;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.net - a.net);
}
