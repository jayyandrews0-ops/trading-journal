// Trading Journal — UI wiring. Data in db.js (IndexedDB), math in calc.js,
// MT5 bridge payload handling in live.js (served by tools/serve.py at ./live).
import * as db from './db.js';
import { pnl, rMultiple, outcome, summarize, equitySeries, bySetup, byGrade, roi, tradeTime,
  equityPoints, manualBalanceEvents, niceTicks, indexStep, setupLabel,
  SETUP_FIELDS, groupByDay, dayLabel, riskStatus } from './calc.js';
import { buildPositions, accountSummary, liveEquitySeries,
  closePrice, liveFloating, contractSize, fxDivisor,
  parseBrokerTime } from './live.js';

const $ = (sel) => document.querySelector(sel);

// Currency-aware money formatting; falls back to plain numbers when the
// currency code is missing/invalid, and adds "+" manually on old Safari.
function makeMoneyFmt(currency, signed) {
  const opts = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (signed) opts.signDisplay = 'always';
  let fmt;
  try {
    fmt = currency
      ? new Intl.NumberFormat(undefined, { style: 'currency', currency, ...opts })
      : new Intl.NumberFormat(undefined, opts);
  } catch {
    fmt = new Intl.NumberFormat(undefined, opts);
  }
  if (signed && fmt.resolvedOptions && fmt.resolvedOptions().signDisplay !== 'always') {
    const base = fmt;
    return { format: (n) => (n > 0 ? '+' : '') + base.format(n) };
  }
  return fmt;
}

const ACCOUNT_KEY = 'tj.account';

function loadAccount() {
  try {
    const a = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || '{}');
    return {
      name: typeof a.name === 'string' ? a.name : '',
      startingBalance: typeof a.startingBalance === 'number' && isFinite(a.startingBalance) ? a.startingBalance : null,
      currency: (typeof a.currency === 'string' && a.currency.trim() ? a.currency : 'USD').toUpperCase(),
    };
  } catch {
    return { name: '', startingBalance: null, currency: 'USD' };
  }
}

let account = loadAccount();

const RULES_KEY = 'tj.rules';

// Funded-account loss limits shown on the Stats equity curve.
function loadRules() {
  const num = (v, d) => {
    if (v === undefined) return d;          // never stored -> default
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
  };
  try {
    const r = JSON.parse(localStorage.getItem(RULES_KEY) || '{}');
    return { dailyPct: num(r.dailyPct, 10), weeklyPct: num(r.weeklyPct, 23) };
  } catch {
    return { dailyPct: 10, weeklyPct: 23 };
  }
}

let rules = loadRules();

function fillRulesForm() {
  $('#rule-daily').value = rules.dailyPct ?? '';
  $('#rule-weekly').value = rules.weeklyPct ?? '';
}

for (const id of ['#rule-daily', '#rule-weekly']) {
  $(id).addEventListener('change', () => {
    const pct = (v) => {
      v = v.trim();
      if (v === '') return null;
      const n = Number(v);
      return isFinite(n) && n > 0 ? n : null;
    };
    rules = {
      dailyPct: pct($('#rule-daily').value),
      weeklyPct: pct($('#rule-weekly').value),
    };
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
    fillRulesForm();
    if ($('#view-stats').classList.contains('active')) renderStats();
  });
}

let moneyFmt = makeMoneyFmt(account.currency, true);   // signed: P&L
let balFmt = makeMoneyFmt(account.currency, false);    // unsigned: balances
const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

let trades = [];
let live = null;               // last /live payload; null => manual mode
let positions = [];            // buildPositions() output (raw, un-annotated)
let annotationsById = new Map();
let searchText = '';
let outcomeFilter = 'ALL';
let expandedDays = null;      // Set<dayKey> once the first render runs
let editingId = null;          // null => creating a new trade
let annotatePos = null;        // live position being annotated (sheet open)
let screenshotBlob = null;     // blob chosen in the form (downscaled)
let screenshotKept = false;    // editing: keep the existing screenshot

/* ================= helpers ================= */

function fmtPnl(p) {
  if (p == null) return '—';
  return moneyFmt.format(p);
}

function pnlClass(p) {
  if (p == null || p === 0) return 'flat';
  return p > 0 ? 'pos' : 'neg';
}

function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? (iso || '') : dateFmt.format(d);
}

// Downscale an image File to max 1600px on the longest side -> JPEG Blob.
function processImage(file) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('image encode failed'))),
        'image/jpeg', 0.85
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

/* ================= live data ================= */

function activeCurrency() {
  return (live && live.account && live.account.currency) || account.currency;
}

function refreshFormatters() {
  moneyFmt = makeMoneyFmt(activeCurrency(), true);
  balFmt = makeMoneyFmt(activeCurrency(), false);
}

async function loadAnnotations() {
  const list = await db.getAllAnnotations();
  annotationsById = new Map(list.map((a) => [a.positionId, a]));
}

// Live positions merged with the user's annotations (setup fields,
// notes, stop loss, screenshot).
function liveRows() {
  return positions.map((p) => {
    const a = annotationsById.get(p.positionId);
    return a ? {
      ...p,
      zone: a.zone || '',
      zoneTf: a.zoneTf || '',
      grade: a.grade || '',
      session: a.session || '',
      h1: a.h1 || '',
      tap: a.tap || '',
      review: a.review || '',
      setup: a.setup || '',
      notes: a.notes || '',
      stopLoss: a.stopLoss ?? null,
      screenshot: a.screenshot || null,
    } : p;
  });
}

function currentRows() {
  return live ? liveRows() : trades;
}

let wasLive = false; // went live once this session — losing it means "connection lost"

// Latest live-adjusted values, keyed by position + broker anchor, so a 5 s
// export refresh keeps showing tick-updated numbers when the anchor agrees.
const liveFloatCache = new Map();
let lastStreamAt = 0;     // ms epoch of the last live/tick stream event
let tickFx = null;        // latest conversion-pair quote {pair, bid, ask}

function applyLiveData(data) {
  live = data && data.ok && data.account ? data : null;
  if (live) wasLive = true;
  positions = live ? buildPositions(live.history || [], live.positions || []) : [];
  for (const p of positions) {
    const cached = liveFloatCache.get(p.positionId);
    const anchor = `${p.floatingExported}|${p.currentPriceExported}`;
    if (cached && cached.anchor === anchor) {
      p.floating = cached.floating;
      p.currentPrice = cached.currentPrice;
    }
  }
  refreshFormatters();
  renderAll();
}

async function pollLive() {
  try {
    const res = await fetch('./live', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    applyLiveData(await res.json());
  } catch {
    applyLiveData(null);
  }
}

function renderAll() {
  renderTrades();
  renderAccountStats();
  renderStats();
  // Banner only when a live session drops — a public host simply never had one.
  document.querySelectorAll('.live-banner')
    .forEach((b) => { b.hidden = !!live || !wasLive; });
  $('#fab').hidden = !!live;
  $('#history-caption').hidden = !live;
  $('#stats-caption').textContent = live
    ? 'Live: closed positions from MT5 deal history.'
    : 'Computed from closed trades only.';
}

/* ---------- live stream ---------- */
// SSE keeps the UI ticking between the 5 s bulk exports. On stream failure
// it falls back to plain polling and retries the stream every 30 s.
let eventSource = null;
window.__liveStreamOn = false; // test hook: true while the SSE stream is open
let pollTimer = null;
let sseRetryTimer = null;
const pendingTicks = new Map();
let tickRaf = 0;

function startLive() {
  if (eventSource || document.hidden) return;
  eventSource = new EventSource('./live/stream');
  eventSource.onopen = () => { window.__liveStreamOn = true; stopPollFallback(); };
  eventSource.addEventListener('live', (e) => {
    lastStreamAt = Date.now();
    try { applyLiveData(JSON.parse(e.data)); } catch { /* bad payload */ }
  });
  eventSource.addEventListener('tick', (e) => {
    lastStreamAt = Date.now();
    try { onTick(JSON.parse(e.data)); } catch { /* bad payload */ }
  });
  eventSource.onerror = () => {
    stopStream();
    startPollFallback();
    scheduleSseRetry();
  };
}

function stopStream() {
  window.__liveStreamOn = false;
  if (eventSource) { eventSource.close(); eventSource = null; }
}

function startPollFallback() {
  if (!pollTimer) {
    pollTimer = setInterval(() => { if (!document.hidden) pollLive(); }, 5000);
    pollLive();
  }
}

function stopPollFallback() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function scheduleSseRetry() {
  if (sseRetryTimer) return;
  sseRetryTimer = setTimeout(() => { sseRetryTimer = null; startLive(); }, 30000);
}

function onTick(t) {
  if (t.fx) tickFx = t.fx;
  pendingTicks.set(t.symbol, t);
  if (!tickRaf) tickRaf = requestAnimationFrame(applyTicks);
}

// Apply queued ticks in-place: open-position floating/currentPrice, the
// History rows' P&L cells, Account Equity/Floating/ROI cards, the ROI hero,
// and the equity canvas tail — never a full re-render.
function applyTicks() {
  tickRaf = 0;
  if (!live) { pendingTicks.clear(); return; }
  const fx = fxDivisor(activeCurrency(), tickFx);
  let touched = false;
  for (const [sym, t] of pendingTicks) {
    for (const p of positions) {
      if (p.status !== 'OPEN' || p.symbol !== sym) continue;
      const cs = contractSize(sym);
      const px = closePrice(p.direction, t);
      if (px != null) p.currentPrice = px;
      if (cs != null) p.floating = liveFloating(p, t, fx, cs);
      liveFloatCache.set(p.positionId, {
        anchor: `${p.floatingExported}|${p.currentPriceExported}`,
        floating: p.floating, currentPrice: p.currentPrice,
      });
      touched = true;
    }
  }
  pendingTicks.clear();
  if (!touched) return;
  updateLiveDom();
}

// balance + live floating = live equity
function liveEquity() {
  const floating = positions
    .filter((p) => p.status === 'OPEN')
    .reduce((s, p) => s + (p.floating || 0), 0);
  const balance = (live && live.account && live.account.balance) || 0;
  return { floating, equity: balance + floating };
}

function updateLiveDom() {
  // 1) open rows' P&L cells in the History list
  for (const p of positions) {
    if (p.status !== 'OPEN') continue;
    const row = document.querySelector(`.trade-row[data-position-id="${p.positionId}"]`);
    const pnlEl = row && row.querySelector('.trade-pnl');
    if (pnlEl) {
      pnlEl.textContent = fmtPnl(p.floating);
      pnlEl.className = 'trade-pnl ' + pnlClass(p.floating);
    }
  }
  // 2) Account cards: Equity / Floating P&L / ROI
  const { floating, equity } = liveEquity();
  const sum = accountSummary(live.account, live.history || []);
  const roi = sum.deposits > 0 ? (equity - sum.deposits) / sum.deposits : null;
  const setStat = (name, text) => {
    const el = document.querySelector(
      `#account-live-stats .stat[data-stat="${name}"] .stat-value`);
    if (el) el.textContent = text;
  };
  setStat('Equity', balFmt.format(equity));
  setStat('Floating P&L', fmtPnl(floating));
  setStat('ROI', roi == null ? '—' : fmtPct(roi));
  // 3) ROI hero
  const v = $('#roi-value'), sub = $('#roi-sub');
  if (roi != null) {
    v.textContent = fmtPct(roi);
    v.className = 'roi-value ' + (roi > 0 ? 'pos' : roi < 0 ? 'neg' : 'flat');
    sub.textContent = `Net ${fmtPnl(equity - sum.deposits)} · Equity ${balFmt.format(equity)}`;
  }
  // 4) drawdown panel + equity canvas tail, only while the Stats view is up
  if ($('#view-stats').classList.contains('active')) {
    renderDrawdown();
    drawEquity();
  }
}

function startPolling() {
  startLive();
  setInterval(() => { if (live) updateLivePill(); }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopStream();
      stopPollFallback();
    } else {
      startLive();
      if (!eventSource) pollLive();
    }
  });
}

/* ================= tabs ================= */

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('#' + btn.dataset.view).classList.add('active');
    if (btn.dataset.view === 'view-stats') renderStats();
    if (btn.dataset.view === 'view-account') renderAccountStats();
  });
});

/* ================= account ================= */

function persistAccount() {
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  moneyFmt = makeMoneyFmt(account.currency, true);
  balFmt = makeMoneyFmt(account.currency, false);
}

function fillAccountForm() {
  $('#acc-name').value = account.name;
  $('#acc-balance').value = account.startingBalance ?? '';
  $('#acc-currency').value = account.currency;
}

function fmtPct(r) {
  return (r > 0 ? '+' : '') + (r * 100).toFixed(1) + '%';
}

function renderAccountStats() {
  $('#account-manual').hidden = !!live;
  $('#account-live').hidden = !live;
  if (live) renderAccountLive();
  else renderAccountManual();
}

function renderAccountLive() {
  const acc = live.account || {};
  $('#live-broker').textContent =
    [acc.company, acc.server, acc.login].filter((v) => v != null && v !== '').join(' · ');
  const sum = accountSummary(live.account, live.history || []);
  const open = positions.filter((p) => p.status === 'OPEN').length;
  const closed = positions.filter((p) => p.status === 'CLOSED').length;
  const money = (v) => (v == null ? '—' : balFmt.format(v));
  const signed = (v) => (v == null ? '—' : fmtPnl(v));
  const grid = $('#account-live-stats');
  grid.innerHTML = '';
  grid.append(
    statCard('Balance', money(sum.balance)),
    statCard('Equity', money(sum.equity)),
    statCard('Floating P&L', signed(sum.floating)),
    statCard('Deposits (net)', money(sum.deposits)),
    statCard('Realised P&L', signed(sum.realised)),
    statCard('ROI', sum.roi == null ? '—' : fmtPct(sum.roi)),
    statCard('Open positions', String(open)),
    statCard('Closed trades (30 d)', String(closed)),
  );
  updateLivePill();
}

function updateLivePill() {
  // While the stream is up, age is time since the last live/tick event.
  const streaming = !!eventSource;
  const age = streaming && lastStreamAt
    ? (Date.now() - lastStreamAt) / 1000
    : (Date.now() / 1000 - (live.served_at || 0))
      + ((live.account && live.account.file_age_seconds) || 0);
  const pill = $('#live-pill');
  $('#live-age').textContent = age > 300
    ? 'stale'
    : `Live · updated ${Math.max(0, Math.round(age))}s ago`;
  pill.className = 'live-pill' + (age > 300 ? ' stale' : age > 60 ? ' warn' : '');
}

function renderAccountManual() {
  const s = summarize(trades);
  const r = roi(s.net, account.startingBalance);
  const grid = $('#account-stats');
  grid.innerHTML = '';
  grid.append(
    statCard('Current balance',
      r == null ? '—' : balFmt.format(account.startingBalance + s.net)),
    statCard('Net P&L', s.closed ? fmtPnl(s.net) : '—'),
    statCard('ROI', r == null ? '—' : fmtPct(r),
      r == null ? 'Set a starting balance to see ROI' : ''),
    statCard('Closed trades', String(s.closed)),
  );
}

function renderRoiHero() {
  const v = $('#roi-value');
  const sub = $('#roi-sub');
  if (live) {
    const sum = accountSummary(live.account, live.history || []);
    const r = sum.roi;
    if (r == null || sum.equity == null) {
      v.textContent = '—';
      v.className = 'roi-value flat';
      sub.textContent = 'No deposit data in MT5 history';
    } else {
      v.textContent = fmtPct(r);
      v.className = 'roi-value ' + (r > 0 ? 'pos' : r < 0 ? 'neg' : 'flat');
      sub.textContent = `Net ${fmtPnl(sum.equity - sum.deposits)} · Equity ${balFmt.format(sum.equity)}`;
    }
    return;
  }
  const s = summarize(trades);
  const r = roi(s.net, account.startingBalance);
  if (r == null) {
    v.textContent = '—';
    v.className = 'roi-value flat';
    sub.textContent = 'Set a starting balance in Account';
  } else {
    v.textContent = fmtPct(r);
    v.className = 'roi-value ' + (r > 0 ? 'pos' : r < 0 ? 'neg' : 'flat');
    sub.textContent = `Net ${fmtPnl(s.net)} · Balance ${balFmt.format(account.startingBalance + s.net)}`;
  }
}

$('#btn-save-account').addEventListener('click', () => {
  const sbRaw = $('#acc-balance').value.trim();
  const sb = sbRaw === '' ? null : Number(sbRaw);
  account = {
    name: $('#acc-name').value.trim(),
    startingBalance: sb != null && isFinite(sb) ? sb : null,
    currency: ($('#acc-currency').value.trim() || 'USD').toUpperCase(),
  };
  persistAccount();
  fillAccountForm();
  renderAccountStats();
  renderTrades(); // refresh ROI hero + currency formatting
});

/* ================= trade list ================= */

function renderTrades() {
  const q = searchText.trim().toLowerCase();
  const list = currentRows().filter((t) => {
    if (outcomeFilter !== 'ALL' && outcome(t) !== outcomeFilter) return false;
    if (!q) return true;
    return [t.symbol, t.setup, t.zone, t.zoneTf, t.grade, t.session,
      t.h1, t.tap, t.review, t.notes]
      .some((s) => (s || '').toLowerCase().includes(q));
  });
  if (!live) list.sort((a, b) => (b.date || '').localeCompare(a.date || '')); // live rows arrive pre-sorted

  renderRoiHero();

  const ul = $('#trade-list');
  ul.innerHTML = '';
  const emptyEl = $('#trades-empty');
  emptyEl.textContent = live
    ? 'No closed trades yet'
    : 'No trades yet. Tap + to log your first trade.';
  emptyEl.hidden = (live ? positions.length : trades.length) !== 0;

  const groups = groupByDay(list);
  // First render: newest day open, the rest collapsed. Afterwards the
  // user's choices are kept across live updates and filter changes.
  if (expandedDays === null && groups.length) {
    expandedDays = new Set([groups[0].key]);
  }
  const searching = q !== '';

  for (const g of groups) {
    const groupLi = document.createElement('li');
    groupLi.className = 'day-group';
    groupLi.dataset.day = g.key;

    const expanded = searching || expandedDays.has(g.key);
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'day-row';
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');

    const chev = document.createElement('span');
    chev.className = 'day-chev';
    chev.textContent = '›';

    const main = document.createElement('span');
    main.className = 'day-main';
    const label = document.createElement('div');
    label.className = 'day-label';
    label.textContent = dayLabel(g.key);
    const sub = document.createElement('div');
    sub.className = 'day-sub';
    const parts = [
      `${g.trades.length} ${g.trades.length === 1 ? 'trade' : 'trades'}`];
    if (g.closed > 0) parts.push(`${g.wins}W ${g.losses}L`);
    if (g.open > 0) parts.push(`${g.open} open`);
    sub.textContent = parts.join(' · ');
    main.append(label, sub);

    const net = document.createElement('span');
    if (g.closed > 0) {
      net.className = 'day-net ' + pnlClass(g.net);
      net.textContent = fmtPnl(g.net);
    } else {
      net.className = 'day-net flat';
      net.textContent = '—';
    }
    header.append(chev, main, net);

    const dayTrades = document.createElement('ul');
    dayTrades.className = 'day-trades';
    dayTrades.hidden = !expanded;
    for (const t of g.trades) dayTrades.append(buildTradeLi(t));

    groupLi.append(header, dayTrades);
    ul.append(groupLi);
  }
}

function buildTradeLi(t) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.className = 'trade-row';
    row.type = 'button';
    const isLive = t.source === 'live';
    if (isLive) row.dataset.positionId = t.positionId;

    const badgeWrap = document.createElement('span');
    const badge = document.createElement('span');
    badge.className = 'badge ' + (t.direction === 'SHORT' ? 'badge-short' : 'badge-long');
    badge.textContent = t.direction === 'SHORT' ? 'SHORT' : 'LONG';
    badgeWrap.append(badge);
    if (isLive && t.status !== 'CLOSED') {
      const openB = document.createElement('span');
      openB.className = 'badge badge-open';
      openB.textContent = t.status;
      badgeWrap.append(' ', openB);
    }

    const main = document.createElement('span');
    main.className = 'trade-main';
    const sym = document.createElement('div');
    sym.className = 'trade-symbol';
    sym.textContent = t.symbol;
    const sub = document.createElement('div');
    sub.className = 'trade-sub';
    sub.textContent = [
      fmtDate(tradeTime(t)),
      isLive && t.volume != null ? `${t.volume} lots` : null,
      setupLabel(t),
      t.grade,
      t.review,
    ].filter(Boolean).join(' · ');
    main.append(sym, sub);

    const right = document.createElement('span');
    right.className = 'trade-right';
    const p = isLive ? (t.status === 'OPEN' ? t.floating : t.net) : pnl(t);
    const pnlEl = document.createElement('div');
    pnlEl.className = 'trade-pnl ' + pnlClass(p);
    pnlEl.textContent = p == null ? 'OPEN' : fmtPnl(p);
    const rEl = document.createElement('div');
    rEl.className = 'trade-r';
    const r = rMultiple(t);
    rEl.textContent = r == null ? '' : r.toFixed(2) + 'R';
    right.append(pnlEl, rEl);

    row.append(badgeWrap, main, right);
    row.addEventListener('click', () => openForm(t));
    li.append(row);
    return li;
}

// Expand/collapse a day (one delegated listener; trade-row clicks inside
// .day-trades don't match .day-row). Search re-renders expand every group
// without touching expandedDays.
$('#trade-list').addEventListener('click', (e) => {
  const header = e.target.closest('.day-row');
  if (!header) return;
  const group = header.closest('.day-group');
  const inner = group.querySelector('.day-trades');
  const expand = inner.hidden;
  inner.hidden = !expand;
  header.setAttribute('aria-expanded', String(expand));
  if (expand) expandedDays.add(group.dataset.day);
  else expandedDays.delete(group.dataset.day);
});

$('#search').addEventListener('input', (e) => { searchText = e.target.value; renderTrades(); });

$('#outcome-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  outcomeFilter = chip.dataset.outcome;
  document.querySelectorAll('#outcome-chips .chip')
    .forEach((c) => c.classList.toggle('active', c === chip));
  renderTrades();
});

/* ================= trade form ================= */

const sheet = $('#sheet');
const form = $('#trade-form');
let previewObjectURL = null;

function localDatetimeNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setDirection(dir) {
  form.dataset.direction = dir;
  document.querySelectorAll('#direction-seg .seg-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.dir === dir));
  updatePreview();
}

$('#direction-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (btn) setDirection(btn.dataset.dir);
});

/* ---------- setup dropdowns ---------- */

const CUSTOM_OPTIONS_KEY = 'journal.customOptions.v1';
const ADD_VALUE = '__add__';

function customOptions() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_OPTIONS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveCustomOption(field, label) {
  const all = customOptions();
  const list = all[field] || (all[field] = []);
  if (!list.some((v) => v.toLowerCase() === label.toLowerCase())) {
    list.push(label);
    localStorage.setItem(CUSTOM_OPTIONS_KEY, JSON.stringify(all));
  }
}

// Option set for a field = defaults ∪ persisted customs ∪ values already
// stored on trades/annotations (a stored value never renders as blank).
function optionValuesFor(field) {
  const def = SETUP_FIELDS.find((f) => f.name === field);
  const seen = new Set();
  const out = [];
  const push = (v) => {
    const k = v.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  };
  (def ? def.options : []).forEach(push);
  (customOptions()[field] || []).forEach(push);
  for (const t of [...trades, ...annotationsById.values()]) {
    if (t[field]) push(t[field]);
  }
  return out;
}

function fillSelect(select, field) {
  const cur = select.value;
  select.innerHTML = '';
  select.add(new Option('—', ''));
  for (const v of optionValuesFor(field)) select.add(new Option(v, v));
  select.add(new Option('＋ Add new…', ADD_VALUE));
  select.value = cur;
}

// Insert a stored value into the list when it isn't already there so the
// select can hold it (e.g. an option the user later removed).
function ensureOption(select, value) {
  if (!value) return '';
  const found = [...select.options].find(
    (o) => o.value !== ADD_VALUE && o.value.toLowerCase() === value.toLowerCase());
  if (found) return found.value;
  const addOpt = select.options[select.options.length - 1];
  select.add(new Option(value, value), addOpt);
  return value;
}

for (const f of SETUP_FIELDS) {
  const select = form.elements[f.name];
  const row = select.closest('.field').querySelector('.add-option-row');
  const input = row.querySelector('input');
  const commit = () => {
    const v = input.value.trim();
    if (v) {
      const existing = [...select.options].find(
        (o) => o.value !== ADD_VALUE
          && o.value.toLowerCase() === v.toLowerCase());
      if (existing) {
        select.value = existing.value;
      } else {
        ensureOption(select, v);
        select.value = v;
        saveCustomOption(f.name, v);
      }
    }
    row.hidden = true;
  };
  select.addEventListener('change', () => {
    if (select.value === ADD_VALUE) {
      select.value = '';
      input.value = '';
      row.hidden = false;
      input.focus();
    }
  });
  row.querySelector('button').addEventListener('click', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
  });
}

// Rebuild every select's option list and assign the record's values.
function fillSetupSelects(src) {
  for (const f of SETUP_FIELDS) {
    const select = form.elements[f.name];
    fillSelect(select, f.name);
    select.value = ensureOption(select, src[f.name] || '');
    select.closest('.field').querySelector('.add-option-row').hidden = true;
  }
}

// Derived legacy label: set when a zone field is chosen, otherwise keep
// whatever free-text setup the record already had.
function setupFromSelects(obj, previous) {
  return (obj.zone || obj.zoneTf) ? setupLabel(obj) : (previous || '');
}

function showScreenshotPreview(blob) {
  if (previewObjectURL) URL.revokeObjectURL(previewObjectURL);
  previewObjectURL = blob ? URL.createObjectURL(blob) : null;
  const img = $('#screenshot-preview');
  img.hidden = !blob;
  if (blob) img.src = previewObjectURL;
  $('#btn-remove-screenshot').hidden = !blob;
  $('#screenshot-label').textContent = blob ? 'Change image…' : 'Choose image…';
}

// Read-only header shown when annotating a live position.
function fillAnnotateSummary(p) {
  const el = $('#annotate-summary');
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'as-title';
  title.textContent = `${p.symbol} ${p.direction} · ${p.volume} lots`;
  const px = (n) => (n == null ? '—' : n);
  const money = p.status === 'OPEN' ? p.floating : p.net;
  const l2 = document.createElement('div');
  l2.className = 'as-line';
  l2.textContent = `${px(p.entry)} → ${p.exit == null ? 'open' : p.exit} · ${fmtPnl(money)}`;
  const l3 = document.createElement('div');
  l3.className = 'as-line';
  l3.textContent = `opened ${fmtDate(p.openTime)}`
    + (p.closeTime ? ` · closed ${fmtDate(p.closeTime)}` : ' · still open');
  el.append(title, l2, l3);
  el.hidden = false;
}

function openForm(trade) {
  annotatePos = trade && trade.source === 'live' ? trade : null;
  editingId = annotatePos ? null : (trade ? trade.id : null);
  $('#sheet-title').textContent =
    annotatePos ? 'Annotate position' : trade ? 'Edit trade' : 'New trade';
  const delBtn = $('#btn-delete');
  delBtn.textContent = annotatePos ? 'Remove annotation' : 'Delete trade';
  delBtn.hidden = annotatePos ? !annotationsById.has(trade.positionId) : !trade;

  form.reset();
  form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  document.querySelectorAll('.manual-only')
    .forEach((el) => { el.hidden = !!annotatePos; });
  setDirection(trade ? trade.direction : 'LONG');

  if (annotatePos) {
    fillAnnotateSummary(trade);
    const a = annotationsById.get(trade.positionId) || {};
    fillSetupSelects(a);
    form.stopLoss.value = a.stopLoss ?? '';
    form.notes.value = a.notes || '';
    $('#screenshot-input').value = '';
    screenshotBlob = null;
    screenshotKept = !!a.screenshot;
    showScreenshotPreview(a.screenshot || null);
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    updatePreview();
    return;
  }
  $('#annotate-summary').hidden = true;

  form.symbol.value = trade ? trade.symbol : '';
  form.date.value = trade ? (trade.date || '') : localDatetimeNow();
  form.entry.value = trade && trade.entry != null ? trade.entry : '';
  form.exit.value = trade && trade.exit != null ? trade.exit : '';
  form.size.value = trade && trade.size != null ? trade.size : '';
  form.stopLoss.value = trade && trade.stopLoss != null ? trade.stopLoss : '';
  form.fees.value = trade && trade.fees != null ? trade.fees : '';
  fillSetupSelects(trade || {});
  form.notes.value = trade ? (trade.notes || '') : '';
  $('#screenshot-input').value = '';

  screenshotBlob = null;
  screenshotKept = !!(trade && trade.screenshot);
  showScreenshotPreview(trade && trade.screenshot ? trade.screenshot : null);

  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  updatePreview();
}

function closeForm() {
  sheet.hidden = true;
  document.body.style.overflow = '';
  showScreenshotPreview(null);
}

$('#fab').addEventListener('click', () => openForm(null));
$('#btn-cancel').addEventListener('click', closeForm);

$('#screenshot-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    screenshotBlob = await processImage(file);
    screenshotKept = false;
    showScreenshotPreview(screenshotBlob);
  } catch {
    alert('Could not read that image.');
  }
});

$('#btn-remove-screenshot').addEventListener('click', () => {
  screenshotBlob = null;
  screenshotKept = false;
  $('#screenshot-input').value = '';
  showScreenshotPreview(null);
});

$('#screenshot-preview').addEventListener('click', () => {
  const src = $('#screenshot-preview').src;
  if (!src) return;
  $('#img-viewer-img').src = src;
  $('#img-viewer').hidden = false;
});
$('#img-viewer').addEventListener('click', () => { $('#img-viewer').hidden = true; });

// Live computed preview while typing.
function formTrade() {
  const num = (v) => (v === '' || v == null ? null : Number(v));
  return {
    direction: form.dataset.direction || 'LONG',
    entry: num(form.entry.value),
    exit: num(form.exit.value),
    size: num(form.size.value),
    stopLoss: num(form.stopLoss.value),
    fees: num(form.fees.value) || 0,
  };
}

function updatePreview() {
  const pnlEl = $('#pv-pnl');
  if (annotatePos) {
    const slNum = form.stopLoss.value === '' ? null : Number(form.stopLoss.value);
    const pseudo = { ...annotatePos, stopLoss: slNum != null && isFinite(slNum) ? slNum : annotatePos.stopLoss };
    const p = annotatePos.status === 'OPEN' ? annotatePos.floating : annotatePos.net;
    pnlEl.textContent = fmtPnl(p);
    pnlEl.className = pnlClass(p);
    const r = rMultiple(pseudo);
    $('#pv-r').textContent = r == null ? '—' : r.toFixed(2) + 'R';
    $('#pv-outcome').textContent = outcome(pseudo);
    return;
  }
  const t = formTrade();
  const p = pnl(t);
  const r = rMultiple(t);
  const o = outcome(t);
  pnlEl.textContent = fmtPnl(p);
  pnlEl.className = pnlClass(p);
  $('#pv-r').textContent = r == null ? '—' : r.toFixed(2) + 'R';
  $('#pv-outcome').textContent = o;
}

form.addEventListener('input', updatePreview);

function validate(t) {
  let ok = true;
  const mark = (input, valid) => {
    input.classList.toggle('invalid', !valid);
    if (!valid) ok = false;
  };
  mark(form.symbol, !!t.symbol);
  mark(form.date, !!t.date);
  mark(form.entry, t.entry != null && isFinite(t.entry));
  mark(form.size, t.size != null && isFinite(t.size));
  return ok;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (annotatePos) {
    const slRaw = form.stopLoss.value.trim();
    const slNum = slRaw === '' ? null : Number(slRaw);
    const a = {
      positionId: annotatePos.positionId,
      stopLoss: slNum != null && isFinite(slNum) ? slNum : null,
      notes: form.notes.value,
      screenshot: screenshotBlob
        || (screenshotKept ? (annotationsById.get(annotatePos.positionId) || {}).screenshot || null : null),
      updatedAt: new Date().toISOString(),
    };
    for (const f of SETUP_FIELDS) a[f.name] = form.elements[f.name].value;
    a.setup = setupFromSelects(
      a, (annotationsById.get(a.positionId) || {}).setup);
    await db.putAnnotation(a);
    annotationsById.set(a.positionId, a);
    closeForm();
    renderAll();
    return;
  }
  const ft = formTrade();
  const trade = {
    date: form.date.value,
    symbol: form.symbol.value.trim().toUpperCase(),
    direction: ft.direction,
    entry: ft.entry,
    exit: ft.exit,
    size: ft.size,
    stopLoss: ft.stopLoss,
    fees: ft.fees || 0,
    notes: form.notes.value,
    screenshot: screenshotBlob || (screenshotKept ? (trades.find((t) => t.id === editingId) || {}).screenshot || null : null),
    updatedAt: new Date().toISOString(),
  };
  for (const f of SETUP_FIELDS) trade[f.name] = form.elements[f.name].value;
  trade.setup = setupFromSelects(
    trade, (trades.find((t) => t.id === editingId) || {}).setup);
  if (!validate(trade)) return;

  if (editingId != null) {
    trade.id = editingId;
    trade.createdAt = (trades.find((t) => t.id === editingId) || {}).createdAt || trade.updatedAt;
  } else {
    trade.createdAt = trade.updatedAt;
  }
  await db.put(trade);
  await reload();
  closeForm();
});

$('#btn-delete').addEventListener('click', async () => {
  if (annotatePos) {
    if (!confirm('Remove this annotation?')) return;
    await db.removeAnnotation(annotatePos.positionId);
    annotationsById.delete(annotatePos.positionId);
    closeForm();
    renderAll();
    return;
  }
  if (editingId == null) return;
  if (!confirm('Delete this trade? This cannot be undone.')) return;
  await db.remove(editingId);
  await reload();
  closeForm();
});

/* ================= stats ================= */

function statCard(label, value, sub) {
  const div = document.createElement('div');
  div.className = 'stat';
  div.dataset.stat = label;
  const l = document.createElement('div');
  l.className = 'stat-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'stat-value';
  v.textContent = value;
  div.append(l, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'stat-sub';
    s.textContent = sub;
    div.append(s);
  }
  return div;
}

function renderStats() {
  const s = summarize(currentRows());
  const grid = $('#stats-grid');
  grid.innerHTML = '';

  const pf = s.profitFactor == null ? '—'
    : s.profitFactor === Infinity ? '∞'
    : s.profitFactor.toFixed(2);

  grid.append(
    statCard('Total trades', String(s.total), `${s.closed} closed`),
    statCard('Win rate', s.winRate == null ? '—' : (s.winRate * 100).toFixed(1) + '%'),
    statCard('Net P&L', fmtPnl(s.closed ? s.net : null)),
    statCard('Average R', s.avgR == null ? '—' : s.avgR.toFixed(2) + 'R'),
    statCard('Profit factor', pf),
    statCard('Streak', s.streak ? `${s.streak.count} ${s.streak.type}` : '—'),
    statCard('Best', s.best ? fmtPnl(s.best.pnl) : '—', s.best ? s.best.trade.symbol : ''),
    statCard('Worst', s.worst ? fmtPnl(s.worst.pnl) : '—', s.worst ? s.worst.trade.symbol : ''),
  );

  renderDrawdown();
  drawEquity();
  renderBreakdown('#setup-table', '#setup-empty', bySetup(currentRows()));
  renderBreakdown('#grade-table', '#grade-empty', byGrade(currentRows()));
}

// Funded-account drawdown panel on Stats: balance/equity/period-start cards
// plus a "£ left" bar per rule, measured against live equity.
function renderDrawdown() {
  const card = $('#drawdown-card');
  let points, equity, today;
  if (live) {
    const series = liveEquitySeries(
      live.account, live.history || [], live.positions || []);
    points = series.points;
    equity = liveEquity().equity;
    today = parseBrokerTime(live.account.timestamp).slice(0, 10);
  } else {
    if (account.startingBalance == null) { card.hidden = true; return; }
    const events = manualBalanceEvents(trades)
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    points = equityPoints(account.startingBalance, events);
    equity = null; // manual has no live equity — measure against balance
    today = localDatetimeNow().slice(0, 10);
  }
  if (!(rules.dailyPct > 0) && !(rules.weeklyPct > 0)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const st = riskStatus(points, rules, { today, equity });

  const grid = $('#dd-grid');
  grid.innerHTML = '';
  grid.append(statCard('Current balance', balFmt.format(st.balance)));
  const eqCard = statCard('Current equity', balFmt.format(st.equity));
  eqCard.dataset.stat = 'dd-equity'; // patched by updateLiveDom
  grid.append(eqCard);
  if (st.daily) {
    grid.append(statCard("Today's starting balance",
      balFmt.format(st.daily.periodStart)));
  }
  if (st.weekly) {
    grid.append(statCard("Week's starting balance",
      balFmt.format(st.weekly.periodStart)));
  }

  const renderRule = (id, st2) => {
    const el = $(id);
    if (!st2) { el.hidden = true; return; }
    el.hidden = false;
    el.querySelector('.dd-pct').textContent = `${st2.pct}%`;
    const leftEl = el.querySelector('.dd-left');
    if (st2.frozen) {
      leftEl.className = 'dd-left breached';
      leftEl.textContent = 'Breached'
        + (st2.breach && st2.breach.time ? ` · ${fmtDate(st2.breach.time)}` : '');
    } else if (st2.left <= 0) {
      leftEl.className = 'dd-left breached';
      leftEl.textContent = 'Breached · live';
    } else {
      leftEl.className = 'dd-left';
      leftEl.textContent = `${balFmt.format(st2.left)} left`;
    }
    const bar = el.querySelector('.dd-bar');
    bar.innerHTML = '';
    const usedSegs = st2.used >= 1 ? 30
      : st2.used > 0 ? Math.max(1, Math.round(st2.used * 30)) : 0;
    for (let i = 0; i < 30; i++) {
      const seg = document.createElement('i');
      if (i < usedSegs) seg.className = 'used';
      bar.append(seg);
    }
    el.querySelector('.dd-level').textContent = balFmt.format(st2.level);
  };
  renderRule('#dd-daily', st.daily);
  renderRule('#dd-weekly', st.weekly);
}

function drawEquity() {
  const canvas = $('#equity-canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (live) {
    const series = liveEquitySeries(
      live.account, live.history || [], live.positions || []);
    drawEquityCurve(ctx, w, h, series, liveEquity().equity, true);
    return;
  }

  if (account.startingBalance == null) {
    drawPnlFallback(ctx, w, h);
    return;
  }

  const events = manualBalanceEvents(trades)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  drawEquityCurve(ctx, w, h,
    { label: 'Start', points: equityPoints(account.startingBalance, events) },
    null, false);
}

// Pre-balance view: plain cumulative net P&L when no starting balance is set.
const NO_BALANCE_HINT = 'Set a starting balance in Account to anchor the curve at your deposit';
function drawPnlFallback(ctx, w, h) {
  const pts = equitySeries(currentRows());
  if (!pts.length) {
    ctx.fillStyle = '#8b949e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '13px sans-serif';
    ctx.fillText('No closed trades yet', w / 2, h / 2 - 10);
    ctx.font = '11px sans-serif';
    ctx.fillText(NO_BALANCE_HINT, w / 2, h / 2 + 12);
    return;
  }

  const padL = 8, padR = 8, padT = 10, padB = 10;
  const values = pts.map((p) => p.value);
  let min = Math.min(0, ...values), max = Math.max(0, ...values);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => padL + (pts.length === 1 ? (w - padL - padR) / 2 : i * (w - padL - padR) / (pts.length - 1));
  const y = (v) => padT + (max - v) * (h - padT - padB) / (max - min);

  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, y(0));
  ctx.lineTo(w - padR, y(0));
  ctx.stroke();

  const last = values[values.length - 1];
  ctx.strokeStyle = last >= 0 ? '#3fb950' : '#f85149';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value)); });
  ctx.stroke();

  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.arc(x(pts.length - 1), y(last), 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.font = '10px sans-serif';
  while (ctx.measureText(NO_BALANCE_HINT).width > w - 16
      && Number(ctx.font.match(/\d+/)[0]) > 9) {
    ctx.font = `${Number(ctx.font.match(/\d+/)[0]) - 1}px sans-serif`;
  }
  ctx.fillText(NO_BALANCE_HINT, w / 2, h - 4);
}

// Classic equity curve: x = trade index (0 = starting balance), y = balance.
// Horizontal gridlines with value labels in the left gutter, trade-index
// ticks along the bottom, a dashed baseline at the start value carrying the
// only non-axis label ("Deposit £103.10" / "Start …"), a plain polyline,
// and a dotted connector to live equity when it differs from the balance.
function drawEquityCurve(ctx, w, h, series, equity, isLive) {
  const padL = 46, padR = 10, padT = 10, padB = 16;
  const pts = series.points;
  const values = pts.map((p) => p.value);
  if (equity != null && isFinite(equity)) values.push(equity);
  let min = Math.min(...values), max = Math.max(...values);
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.01);
    min -= pad; max += pad;
  } else {
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
  }

  const n = pts[pts.length - 1].i;
  const x = (i) => padL + (n ? i * (w - padL - padR) / n : 0);
  const y = (v) => padT + (max - v) * (h - padT - padB) / (max - min);
  const line = pts[pts.length - 1].value >= pts[0].value ? '#3fb950' : '#f85149';

  // horizontal gridlines + value labels in the gutter; fall back to a plain
  // number format when the currency label would overflow the gutter.
  const numFmt = new Intl.NumberFormat(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ticks = niceTicks(min, max);
  ctx.font = '10px sans-serif';
  const widest = ticks.reduce(
    (m, t) => Math.max(m, ctx.measureText(balFmt.format(t)).width), 0);
  const tickFmt = widest <= padL - 8 ? balFmt : numFmt;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of ticks) {
    const ty = y(t);
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, ty);
    ctx.lineTo(w - padR, ty);
    ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.fillText(tickFmt.format(t), padL - 5, ty);
  }

  // trade-index x ticks + faint vertical gridlines
  const step = indexStep(n);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= n; i += step) {
    const tx = x(i);
    ctx.strokeStyle = '#21262d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx, padT);
    ctx.lineTo(tx, h - padB);
    ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.fillText(String(i), tx, h - padB + 3);
  }

  // start-value baseline + its label — the only non-axis text
  const baseY = y(pts[0].value);
  ctx.strokeStyle = '#8b949e';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, baseY);
  ctx.lineTo(w - padR, baseY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#8b949e';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${series.label} ${balFmt.format(pts[0].value)}`, padL + 2, baseY - 3);

  // the line: straight point-to-point segments. A deposit fold lifts the
  // line to the post-deposit level at the previous index — drawn separately
  // as a dotted vertical at x_i — so the following trade segment's slope is
  // the trade's own delta, not trade + deposit.
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x(pts[0].i), y(pts[0].value));
  for (let j = 1; j < pts.length; j++) {
    const p = pts[j];
    if (p.kind === 'deposit') {
      ctx.moveTo(x(pts[j - 1].i), y(p.value)); // pen lifts to post-deposit level
    } else {
      ctx.lineTo(x(p.i), y(p.value));
    }
  }
  ctx.stroke();

  for (let j = 1; j < pts.length; j++) {
    const p = pts[j];
    if (p.kind !== 'deposit') continue;
    const px = x(p.i);
    ctx.strokeStyle = '#8b949e';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px, y(pts[j - 1].value));
    ctx.lineTo(px, y(p.value));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(px, y(p.value), 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // end dot
  const ex = x(n), ey = y(pts[pts.length - 1].value);
  ctx.fillStyle = line;
  ctx.beginPath();
  ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
  ctx.fill();


  // live equity connector, unlabelled, when it differs from the balance
  if (isLive && equity != null && isFinite(equity)
      && Math.abs(equity - pts[pts.length - 1].value) >= 0.005) {
    const eqY = y(equity);
    ctx.strokeStyle = '#8b949e';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex, eqY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(ex, eqY, 3, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function renderBreakdown(tableSel, emptySel, rows) {
  const tbody = document.querySelector(tableSel + ' tbody');
  tbody.innerHTML = '';
  $(emptySel).hidden = rows.length !== 0;
  for (const r of rows) {
    const tr = document.createElement('tr');
    const wr = (r.wins / r.count * 100).toFixed(0) + '%';
    for (const text of [r.setup, String(r.count), wr, fmtPnl(r.net)]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.append(td);
    }
    tr.lastChild.className = pnlClass(r.net);
    tbody.append(tr);
  }
}

/* ================= pull to refresh ================= */

// Pull down from the top of the page (like a normal webpage): the #ptr
// indicator follows the finger, and releasing past 70px refreshes — first
// asking the service worker to check for updates, then reloading.
const ptr = $('#ptr');
let pullStartY = null;
let pullDist = 0;

const scrollTop = () => (document.scrollingElement || document.documentElement).scrollTop;
const overlayOpen = () => !sheet.hidden || !$('#img-viewer').hidden;

function setPtr(dist) {
  if (!ptr) return;
  ptr.style.transform = `translateX(-50%) translateY(${dist}px)`;
  ptr.classList.toggle('ready', dist >= 70);
}

function pullReset() {
  pullStartY = null;
  pullDist = 0;
  setPtr(0);
}

async function refreshFromPull() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch { /* offline or no SW — reload anyway */ }
  location.reload();
}

window.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1 || overlayOpen() || scrollTop() > 0) return;
  pullStartY = e.touches[0].clientY;
  pullDist = 0;
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (pullStartY == null) return;
  const dy = e.touches[0].clientY - pullStartY;
  if (dy <= 0 || scrollTop() > 0 || overlayOpen()) { pullReset(); return; }
  e.preventDefault(); // pulling at the top — take over the rubber-band
  pullDist = Math.min(dy, 90);
  setPtr(pullDist);
}, { passive: false });

window.addEventListener('touchend', () => {
  if (pullStartY == null) return;
  const fired = pullDist >= 70;
  pullReset();
  if (fired) refreshFromPull();
}, { passive: true });

window.addEventListener('touchcancel', pullReset, { passive: true });

/* ================= service worker ================= */

// Registered silently; the app fully works without it (plain-LAN http included).
// When a new worker takes control (a pull-to-refresh update, or any other
// update), reload once onto the new assets — but never on first install.
let swHadController = false;
let swReloading = false;
if ('serviceWorker' in navigator) {
  swHadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!swHadController) { swHadController = true; return; }
    if (swReloading) return;
    swReloading = true;
    location.reload();
  });
}
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
}

/* ================= init ================= */

async function reload() {
  trades = await db.getAll();
  renderTrades();
  renderAccountStats();
}

fillAccountForm();
fillRulesForm();
loadAnnotations().then(reload).then(startPolling);
