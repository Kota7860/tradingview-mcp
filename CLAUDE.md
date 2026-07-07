# TradingView MCP — Claude Instructions

68 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot
- `quote_multi` → snapshots for up to 20 symbols in one call (restores original chart symbol after)

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Trade on paper (demo) account"
1. `trade_connect_paper` → connect TradingView's Paper Trading broker (must be logged in). Sets no-confirm so orders/closes execute programmatically.
2. `trade_account` → account id, broker, currency
3. `trade_balance` → equity, available funds, balance, total unrealized PnL
4. `trade_place` → market/limit/stop order with optional TP/SL. **Refuses to run against a live broker** — paper only.
5. `trade_positions` → open positions with side, qty, avg price, unrealized PnL (zero-qty residual rows filtered out)
6. `trade_orders` → working orders only by default (readable status/type); `all: true` for filled+canceled, `include_history: true` for history
7. `trade_modify` → change limit/stop price, TP, SL, or qty on a working order (paper only)
8. `trade_close` → close one position by ID, or ALL if no ID
9. `trade_cancel` → cancel a working order

Related non-MCP tooling in `scripts/`:
- `rules_strategy.pine` → the rules.json bias (EMA20 + RSI) as a backtestable Pine strategy, with ATR-based stops/targets, risk-% position sizing, and optional trend + volume filters that mirror bot.js.
- `bot.js` → standalone loop that reads OHLCV, computes EMA/RSI/ATR/trend/volume, applies the rules, and places paper trades with broker-managed SL/TP. Risk sizing from `risk_per_trade_pct`, halts on loss-streak and daily-loss limits, persists state across restarts (`bot.state.json`) and logs to `bot.log`. Copy `bot.config.example.json` → `bot.config.json`. Defaults to `dry_run: true`; run with `--live` to place paper orders.
  - `signal_source` selects the bias source: `"internal"` (bot's own EMA/RSI/ATR/trend/volume), `"fpu"` (reads FPU-MAX-V5's composite %/verdict/regime live from the on-chart panel via `data_get_pine_tables`, then longs when composite ≥ `fpu_bull` / shorts when ≤ `fpu_bear`, gated by regime), or `"combined"` (uses BOTH — merges internal + FPU per `combine_rule`: `all_agree` for confluence, or `either`). `fpu`/`combined` need FPU-MAX-V5 on the chart. Either way the bot handles ATR SL/TP and risk-% sizing.
  - Also has an optional **webhook listener** (`webhook_enabled`) that consumes the FPU-MAX-V5 JSON alert (`{symbol, signal, entry, sl, tp1, ...}`) over HTTP and opens/reverses/closes paper positions through the same risk checks. `webhook_symbol_map` maps alert tickers to broker symbols; optional `webhook_secret` (a `secret` field in the alert JSON). TradingView is cloud-hosted, so expose the port via a tunnel (ngrok) for live TV alerts. Set `poll_enabled: false` for pure webhook mode.
  - **Active management** (`manage_positions`): moves SL to break-even after `be_at_r` and ATR-trails (`trail_enabled`) — live via `trade_modify` on the bracket stop order.
  - **Trade journal**: every close appends to `bot.trades.csv` (entry/exit/pnl/R/source/reason) and updates win%/pnl/avgR stats.
  - **Discipline guards**: `session_filter` (timezone window + skip first N min), per-symbol `cooldown_seconds` after a stop-out, `max_trades_per_day`.
  - **Notifications + status**: Telegram/Discord alerts on open/close/halt (`notify`), and `GET /status` (`status_enabled`) returns a live JSON snapshot (positions, stats, halt state) on the same HTTP server.

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
