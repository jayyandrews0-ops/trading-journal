// Live tick-math tests. Run: node --test 'tools/**/*.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPositions, closePrice, contractSize, fxDivisor, liveFloating,
} from '../live.js';

const SHORT_POS = {
  positionId: 1,
  symbol: 'XAUUSD',
  direction: 'SHORT',
  volume: 0.01,
  currentPriceExported: 4158.09,
  floatingExported: -1.65,
};

test('closePrice: LONG uses bid, SHORT uses ask', () => {
  const tick = { bid: 4158.50, ask: 4158.60 };
  assert.equal(closePrice('LONG', tick), 4158.50);
  assert.equal(closePrice('SHORT', tick), 4158.60);
  assert.equal(closePrice('SELL', tick), 4158.60);
  assert.equal(closePrice('LONG', null), null);
});

test('liveFloating: SELL 0.01 XAUUSD @4158.10 ask, GBP account', () => {
  const f = liveFloating(
    SHORT_POS, { bid: 4158.40, ask: 4158.10 }, 1.32379, 100);
  // -1.65 + (4158.10 - 4158.09) * -1 * 0.01 * 100 / 1.32379 ~= -1.6576
  assert.ok(Math.abs(f - -1.66) < 0.01, `got ${f}`);
});

test('liveFloating: identical tick returns exactly the exported value', () => {
  const f = liveFloating(
    SHORT_POS, { bid: 4158.00, ask: 4158.09 }, 1.32379, 100);
  assert.equal(f, -1.65);
});

test('liveFloating: no fx pair -> exported value unchanged', () => {
  const f = liveFloating(
    SHORT_POS, { bid: 4158.40, ask: 4158.10 }, null, 100);
  assert.equal(f, -1.65);
});

test('liveFloating: USD account uses fx 1', () => {
  const f = liveFloating(
    SHORT_POS, { bid: 4158.40, ask: 4158.10 }, 1, 100);
  assert.ok(Math.abs(f - -1.66) < 1e-9, `got ${f}`); // -1.65 - 0.01 USD
});

test('liveFloating: LONG marks at the bid', () => {
  const pos = { ...SHORT_POS, direction: 'LONG', floatingExported: 0.5 };
  const f = liveFloating(pos, { bid: 4158.50, ask: 4158.60 }, 1, 100);
  assert.ok(Math.abs(f - 0.91) < 1e-9, `got ${f}`);
});

test('contractSize / fxDivisor', () => {
  assert.equal(contractSize('XAUUSD'), 100);
  assert.equal(contractSize('XAUUSD.r'), 100);
  assert.equal(contractSize('XAGUSD'), 5000);
  assert.equal(contractSize('US500'), 1);
  assert.equal(contractSize('EURUSD'), 100000);
  assert.equal(contractSize('EXOTIC'), null);
  // GBP account -> GBPUSD pair divides directly; JPY -> USDJPY inverts.
  assert.equal(fxDivisor('GBP', { pair: 'GBPUSD', bid: 1.32379 }), 1.32379);
  assert.equal(fxDivisor('JPY', { pair: 'USDJPY', bid: 160 }), 1 / 160);
  assert.equal(fxDivisor('USD', { pair: 'GBPUSD', bid: 1.3 }), 1);
  assert.equal(fxDivisor('GBP', null), null);
});

test('buildPositions exposes exported anchors + live fields', () => {
  const deals = [
    { time: '2026.10.05 01:49:13', type: 1, entry: 0, symbol: 'XAUUSD',
      volume: 0.01, profit: 0, commission: -0.05, swap: 0,
      position_id: 255114904, ticket: 1 },
  ];
  const open = [{
    position_id: 255114904, ticket: 9, symbol: 'XAUUSD', type: 'SELL',
    volume: 0.01, price_open: 4155.90, price_current: 4158.09,
    profit: -1.65, sl: 0, time: '2026.10.05 01:49:13',
  }];
  const recs = buildPositions(deals, open);
  assert.equal(recs.length, 1);
  const p = recs[0];
  assert.equal(p.status, 'OPEN');
  assert.equal(p.floatingExported, -1.65);
  assert.equal(p.currentPriceExported, 4158.09);
  assert.equal(p.floating, -1.65);
  assert.equal(p.currentPrice, 4158.09);
});
