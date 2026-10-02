// Trading Journal — UI wiring. Data in db.js (IndexedDB), math in calc.js,
// MT5 bridge payload handling in live.js (served by tools/serve.py at ./live).
import * as db from './db.js';
import { pnl, rMultiple, outcome, summarize, equitySeries, bySetup, roi, tradeTime } from './calc.js';
import { buildPositions, accountSummary } from './live.js';

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

// Live positions merged with the user's annotations (setup/notes/stopLoss/shot).
function liveRows() {
  return positions.map((p) => {
    const a = annotationsById.get(p.positionId);
    return a ? {
      ...p,
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

async function pollLive() {
  try {
    const res = await fetch('./live', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    // Only "connected" when a real account record came back.
    live = data && data.ok && data.account ? data : null;
  } catch {
    live = null;
  }
  if (live) wasLive = true;
  positions = live ? buildPositions(live.history || [], live.positions || []) : [];
  refreshFormatters();
  renderAll();
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

function startPolling() {
  pollLive();
  setInterval(() => { if (!document.hidden) pollLive(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLive(); });
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
  const age = (Date.now() / 1000 - (live.served_at || 0))
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
    return [t.symbol, t.setup, t.notes].some((s) => (s || '').toLowerCase().includes(q));
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

  for (const t of list) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.className = 'trade-row';
    row.type = 'button';
    const isLive = t.source === 'live';

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
      t.setup,
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
    ul.append(li);
  }
}

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

function refreshSetupDatalist() {
  const setups = [...new Set(
    [...trades, ...annotationsById.values()]
      .map((t) => (t.setup || '').trim()).filter(Boolean)
  )].sort();
  $('#setup-list').innerHTML = setups.map((s) => `<option value="${s.replace(/"/g, '&quot;')}">`).join('');
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
  refreshSetupDatalist();

  form.reset();
  form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  document.querySelectorAll('.manual-only')
    .forEach((el) => { el.hidden = !!annotatePos; });
  setDirection(trade ? trade.direction : 'LONG');

  if (annotatePos) {
    fillAnnotateSummary(trade);
    const a = annotationsById.get(trade.positionId) || {};
    form.setup.value = a.setup || '';
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
  form.setup.value = trade ? (trade.setup || '') : '';
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
      setup: form.setup.value.trim(),
      stopLoss: slNum != null && isFinite(slNum) ? slNum : null,
      notes: form.notes.value,
      screenshot: screenshotBlob
        || (screenshotKept ? (annotationsById.get(annotatePos.positionId) || {}).screenshot || null : null),
      updatedAt: new Date().toISOString(),
    };
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
    setup: form.setup.value.trim(),
    notes: form.notes.value,
    screenshot: screenshotBlob || (screenshotKept ? (trades.find((t) => t.id === editingId) || {}).screenshot || null : null),
    updatedAt: new Date().toISOString(),
  };
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

  drawEquity();
  renderSetupTable();
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

  const pts = equitySeries(currentRows());
  if (!pts.length) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No closed trades yet', w / 2, h / 2);
    return;
  }

  const padL = 8, padR = 8, padT = 10, padB = 10;
  const values = pts.map((p) => p.value);
  let min = Math.min(0, ...values), max = Math.max(0, ...values);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => padL + (pts.length === 1 ? (w - padL - padR) / 2 : i * (w - padL - padR) / (pts.length - 1));
  const y = (v) => padT + (max - v) * (h - padT - padB) / (max - min);

  // zero line
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, y(0));
  ctx.lineTo(w - padR, y(0));
  ctx.stroke();

  // equity line
  const last = values[values.length - 1];
  ctx.strokeStyle = last >= 0 ? '#3fb950' : '#f85149';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value)); });
  ctx.stroke();

  // end dot + value label
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.arc(x(pts.length - 1), y(last), 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function renderSetupTable() {
  const rows = bySetup(currentRows());
  const tbody = document.querySelector('#setup-table tbody');
  tbody.innerHTML = '';
  $('#setup-empty').hidden = rows.length !== 0;
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

/* ================= service worker ================= */

// Registered silently; the app fully works without it (plain-LAN http included).
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
loadAnnotations().then(reload).then(startPolling);
