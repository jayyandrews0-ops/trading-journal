# Trading Journal

A personal trading journal as a Progressive Web App — no accounts, no backend,
no build step. Plain HTML/CSS/vanilla JS; all data stays in your browser's
IndexedDB on the device you use.

## Install on iPhone

1. Open the app URL in **Safari**.
2. Tap **Share**, then **Add to Home Screen**.
3. Launch from the home screen — it runs standalone and works offline.

Your journal is private and stored only on that device. Open the Account tab,
enter your starting balance and currency, then log trades with the + button on
the History tab. The Calendar tab colours each day green/red/grey by closed
P&L and hosts the drawdown-rules panel. The Stats tab summarizes closed
trades (win rate, profit factor, equity curve, per-setup breakdown).

## Running locally

```
python3 tools/serve.py
```

…then open `http://<your-mac-ip>:8080/` on your phone (same Wi-Fi).

## MT5 live mode (optional)

If you run MetaTrader 5 locally, a small exporter EA/script can write three
JSON files every few seconds into `MQL5/Files/ai_trading_platform_data/` (the
platform's shared Files folder — under Wine this lives in
`drive_c/Program Files/MetaTrader 5/MQL5/Files/...`):

- `account.json` — account snapshot, e.g.
  `{"login": 123, "balance": 1000.0, "equity": 1005.2, "profit": 5.2, "currency": "USD", "company": "…", "server": "…", "timestamp": "YYYY.MM.DD HH:MM:SS"}`
- `history.json` — array of recent deals: `{ticket, position_id, time, type (0 BUY / 1 SELL / 2 BALANCE / 3 CREDIT), entry (0 IN / 1 OUT / 2 INOUT / 3 OUT_BY), symbol, volume, price, profit, commission, swap, comment}`
- `positions.json` — array of open positions: `{position_id, symbol, type "BUY"|"SELL", volume, price_open, sl, tp, price_current, profit, time}`

Then serve the app with:

```
python3 tools/serve.py --data-dir "/path/to/MQL5/Files/ai_trading_platform_data"
```

(or set `MT5_DATA_DIR`). The app polls `./live` every 5 s and, when present,
switches Account/History/Stats to the live account: open positions with
floating P&L, closed positions from the deal window, balance/equity/ROI from
the account file. Tapping a live row opens the same form as a manual trade: setup dropdowns
(zone, timeframe, grade, session, H1, tap, review — each extensible with
your own options right from the phone), stop loss (for R), notes and a
screenshot — stored locally as an annotation keyed by position id.

`GET ./quality` additionally proxies per-position excursion (MFE/MAE,
capture) from the terminal API's human-vs-STC report — one loopback GET to
`127.0.0.1:8765` per symbol, cached 60 s in-process. It feeds the
Expectancy/excursion stat cards and a per-trade "Moved …" line on the
annotate sheet; when the terminal API is absent it simply contributes
nothing.

On any host without `./live` (e.g. GitHub Pages) the app silently runs in
manual mode.
