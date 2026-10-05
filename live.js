// Pure helpers for MT5 export data — no DOM, no fetches.

// MT5 DEAL_TYPE values
const DEAL_TRADE_TYPES = new Set([0, 1]); // BUY, SELL
const ENTRY_IN = 0, ENTRY_OUT = 1, ENTRY_INOUT = 2, ENTRY_OUT_BY = 3;

// "YYYY.MM.DD HH:MM:SS" (broker time) -> "YYYY-MM-DDTHH:MM:SS".
// Kept as a plain string so it sorts lexicographically; never TZ-converted.
export function parseBrokerTime(s) {
  if (!s) return '';
  const m = /(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}` : String(s);
}

function vwap(deals) {
  let pv = 0, vol = 0;
  for (const d of deals) {
    pv += (d.price || 0) * (d.volume || 0);
    vol += d.volume || 0;
  }
  return vol > 0 ? pv / vol : null;
}

const sum = (deals, key) => deals.reduce((s, d) => s + (d[key] || 0), 0);

function openRecord(p) {
  const exportedPrice = p.price_current ?? null;
  const exportedFloating = p.profit ?? null;
  return {
    positionId: p.position_id ?? p.ticket,
    symbol: p.symbol,
    direction: p.type === 'SELL' ? 'SHORT' : 'LONG',
    volume: p.volume,
    entry: p.price_open,
    exit: null,
    openTime: parseBrokerTime(p.time),
    closeTime: null,
    profit: 0, commission: 0, swap: 0,
    net: 0,
    status: 'OPEN',
    tickets: [p.ticket],
    source: 'live',
    sl: p.sl || null,
    currentPriceExported: exportedPrice,
    floatingExported: exportedFloating,
    currentPrice: exportedPrice,
    floating: exportedFloating,
  };
}

// Group deals by position_id and fold in still-open positions.
export function buildPositions(deals, openPositions) {
  const groups = new Map();
  for (const d of deals || []) {
    if (!DEAL_TRADE_TYPES.has(d.type) || !(d.position_id > 0)) continue;
    if (!groups.has(d.position_id)) groups.set(d.position_id, []);
    groups.get(d.position_id).push(d);
  }

  const openById = new Map(
    (openPositions || []).map((p) => [p.position_id ?? p.ticket, p])
  );

  const out = [];
  for (const [positionId, ds] of groups) {
    const ins = ds.filter((d) => d.entry === ENTRY_IN || d.entry === ENTRY_INOUT);
    const outs = ds.filter((d) => d.entry === ENTRY_OUT || d.entry === ENTRY_OUT_BY);
    const inVol = sum(ins, 'volume');
    const outVol = sum(outs, 'volume');
    const firstIn = ins[0] || ds[0];
    const times = ds.map((d) => parseBrokerTime(d.time)).sort();
    const openPos = openById.get(positionId);

    const closed = outVol >= inVol - 1e-9;
    const rec = {
      positionId,
      symbol: firstIn.symbol,
      direction: firstIn.type === 1 ? 'SHORT' : 'LONG',
      volume: inVol,
      entry: vwap(ins),
      exit: outs.length ? vwap(outs) : null,
      openTime: times[0] || '',
      closeTime: outs.length ? times[times.length - 1] : null,
      profit: sum(ds, 'profit'),
      commission: sum(ds, 'commission'),
      swap: sum(ds, 'swap'),
      net: sum(ds, 'profit') + sum(ds, 'commission') + sum(ds, 'swap'),
      status: closed ? 'CLOSED' : openPos ? 'OPEN' : 'PARTIAL',
      tickets: ds.map((d) => d.ticket),
      source: 'live',
      sl: null,
      currentPriceExported: null,
      floatingExported: null,
      currentPrice: null,
      floating: null,
    };
    if (!closed && openPos) {
      // still open: live ticket data beats 30-day deal aggregates
      rec.volume = openPos.volume;
      rec.entry = openPos.price_open;
      rec.sl = openPos.sl || null;
      rec.currentPriceExported = openPos.price_current ?? null;
      rec.floatingExported = openPos.profit ?? null;
      rec.currentPrice = rec.currentPriceExported;
      rec.floating = rec.floatingExported;
    }
    out.push(rec);
  }

  // Positions open longer than the history window (no IN deal in `deals`).
  for (const p of openPositions || []) {
    if (!groups.has(p.position_id ?? p.ticket)) out.push(openRecord(p));
  }

  const key = (p) => (p.status === 'OPEN' ? p.openTime : (p.closeTime || p.openTime || ''));
  out.sort((a, b) =>
    (b.status === 'OPEN' ? 1 : 0) - (a.status === 'OPEN' ? 1 : 0)
    || String(key(b)).localeCompare(String(key(a))));
  return out;
}

/* ---------- equity curve ---------- */

// Index-based equity series for the live account: point 0 is the balance at
// the first closed trade, point i the balance after the i-th closed position
// (closeTime order, delta = position net). Balance/credit deals on or before
// the first close fold into the starting balance (so the anchor is the
// capital trading started with); later ones fold in at the next trade's
// index as 'deposit' mid-points (dotted step + hollow dot when drawn).
// Nonzero realised-so-far net of OPEN/PARTIAL positions folds into the
// final point, so the curve ends at the broker balance.
export function liveEquitySeries(account, deals, openPositions) {
  const positions = buildPositions(deals || [], openPositions);
  const closed = positions
    .filter((p) => p.status === 'CLOSED' && p.closeTime)
    .sort((a, b) => a.closeTime.localeCompare(b.closeTime));
  const openCost = positions
    .filter((p) => p.status !== 'CLOSED')
    .reduce((s, p) => s + (p.net || 0), 0);
  const balanceDeals = (deals || [])
    .filter((d) => (d.type === 2 || d.type === 3) && d.profit) // BALANCE / CREDIT
    .map((d) => ({ time: parseBrokerTime(d.time), delta: d.profit }))
    .sort((a, b) => a.time.localeCompare(b.time));

  const posNet = closed.reduce((s, p) => s + (p.net || 0), 0);
  const balNet = balanceDeals.reduce((s, d) => s + d.delta, 0);
  const carried = (account ? account.balance : 0) - posNet - balNet - openCost;

  const firstClose = closed.length ? closed[0].closeTime : null;
  const pre = [], post = [];
  for (const d of balanceDeals) {
    (firstClose && d.time > firstClose ? post : pre).push(d);
  }
  const startValue = carried + pre.reduce((s, d) => s + d.delta, 0);
  const label = !closed.length && !balanceDeals.length ? 'Balance'
    : (Math.abs(carried) < 0.005 && pre.length && pre[0].delta > 0) ? 'Deposit'
    : 'Start';

  const points = [{ i: 0, value: startValue, kind: 'start' }];
  let acc = startValue;
  let di = 0;
  for (let i = 1; i <= closed.length; i++) {
    while (di < post.length && post[di].time <= closed[i - 1].closeTime) {
      acc += post[di].delta;
      points.push({ i, value: acc, kind: 'deposit', delta: post[di].delta });
      di++;
    }
    acc += closed[i - 1].net || 0;
    points.push({ i, value: acc, kind: 'trade', delta: closed[i - 1].net || 0 });
  }
  // Deposits after the last close fold at the final index.
  const tailIdx = closed.length || 1;
  while (di < post.length) {
    acc += post[di].delta;
    points.push({ i: tailIdx, value: acc, kind: 'deposit', delta: post[di].delta });
    di++;
  }
  // Open/partial realised costs fold into the final point — never into the
  // starting anchor (a lone start point gets a tail point at index 1).
  if (Math.abs(openCost) >= 0.005) {
    acc += openCost;
    if (points.length > 1) points[points.length - 1].value += openCost;
    else points.push({ i: 1, value: acc, kind: 'cost', delta: openCost });
  }
  return { label, points, end: acc };
}

/* ---------- live tick math ---------- */

// Contract sizes for live floating-P&L adjustment; null = no live adjustment.
const CONTRACT_SIZE = { XAUUSD: 100, XAGUSD: 5000, US500: 1 };
const FOREX_MAJORS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'NZDUSD', 'USDCAD',
  'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY',
];

export function contractSize(symbol) {
  const s = String(symbol || '').toUpperCase().split('.')[0];
  for (const [key, size] of Object.entries(CONTRACT_SIZE)) {
    if (s.startsWith(key)) return size;
  }
  if (FOREX_MAJORS.some((m) => s.startsWith(m))) return 100000;
  return null;
}

// The price an open position marks to: a SELL closes at the ask, a BUY at the bid.
export function closePrice(direction, tick) {
  if (!tick) return null;
  return (direction === 'SHORT' || direction === 'SELL') ? tick.ask : tick.bid;
}

// Conversion-pair divisor for USD-quoted P&L into the account currency.
// XXXUSD pairs (GBPUSD) divide directly; USDXXX pairs (USDJPY) invert.
// 1 for USD accounts, null when the pair is unavailable.
export function fxDivisor(currency, fx) {
  if (!currency || currency.toUpperCase() === 'USD') return 1;
  if (!fx || !fx.bid) return null;
  const pair = String(fx.pair || '').toUpperCase();
  if (pair.endsWith('USD')) return fx.bid;
  if (pair.startsWith('USD')) return 1 / fx.bid;
  return null;
}

// Live floating P&L via the delta method anchored on the broker's own
// export: exported floating + move since the exported price, converted by fx.
// Returns the exported value unchanged when the live inputs are missing.
export function liveFloating(position, tick, fx, cs) {
  const exported = position.floatingExported ?? position.floating ?? 0;
  const ref = position.currentPriceExported ?? position.currentPrice;
  const price = closePrice(position.direction, tick);
  if (price == null || ref == null || cs == null || fx == null || !fx) {
    return exported;
  }
  const dir = (position.direction === 'SHORT' || position.direction === 'SELL') ? -1 : 1;
  return exported + (price - ref) * dir * (position.volume || 0) * cs / fx;
}

// Account-level aggregates from account.json + the 30-day deal window.
export function accountSummary(account, deals) {
  const list = deals || [];
  const deposits = list
    .filter((d) => d.type === 2 || d.type === 3) // BALANCE / CREDIT
    .reduce((s, d) => s + (d.profit || 0), 0);
  const realised = list
    .filter((d) => DEAL_TRADE_TYPES.has(d.type))
    .reduce((s, d) => s + (d.profit || 0) + (d.commission || 0) + (d.swap || 0), 0);
  const equity = account ? account.equity : null;
  return {
    deposits,
    balance: account ? account.balance : null,
    equity,
    floating: account ? (account.profit || 0) : null,
    realised,
    roi: equity != null && deposits > 0 ? (equity - deposits) / deposits : null,
  };
}
