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
    currentPrice: p.price_current ?? null,
    floating: p.profit ?? null,
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
      currentPrice: null,
      floating: null,
    };
    if (!closed && openPos) {
      // still open: live ticket data beats 30-day deal aggregates
      rec.volume = openPos.volume;
      rec.entry = openPos.price_open;
      rec.sl = openPos.sl || null;
      rec.currentPrice = openPos.price_current ?? null;
      rec.floating = openPos.profit ?? null;
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
