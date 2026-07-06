#!/usr/bin/env node
/**
 * Standalone paper-trading bot (v2).
 *
 * Self-running loop (no Claude in the loop): for each configured symbol it reads
 * OHLCV via CDP, computes EMA / RSI / ATR / trend / volume, applies the rules,
 * and opens PAPER positions with broker-managed stop-loss and take-profit.
 *
 * Risk management:
 *   - ATR-based stop-loss and take-profit attached to every entry.
 *   - Position size from risk_per_trade_pct of live equity / stop distance
 *     (falls back to qty_per_trade), capped by max_qty.
 *   - Halts after N consecutive losing exits AND if daily loss exceeds
 *     max_daily_loss_pct of the day's starting equity.
 *
 * Smarter signals:
 *   - Trend filter: longs only above a longer trend EMA, shorts only below.
 *   - Volume filter: entries require volume above its moving average.
 *
 * Reliability & state:
 *   - State (consecutive losses, day PnL anchor, halt status, dry-run book)
 *     persists to state_file across restarts.
 *   - Appends a line-per-event log to log_file.
 *   - Reconnects the paper broker automatically if the connection drops.
 *
 * Safety: dry_run: true (default) logs intended trades without placing them.
 * Only trades the Paper Trading (demo) broker; core.placeOrder refuses live.
 *
 * Usage:
 *   node scripts/bot.js                 # scripts/bot.config.json
 *   node scripts/bot.js my.config.json
 *   node scripts/bot.js --live          # override dry_run to actually trade paper
 */
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import * as data from '../src/core/data.js';
import * as chart from '../src/core/chart.js';
import * as trading from '../src/core/trading.js';
import { disconnect } from '../src/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const resolvePath = (p) => (isAbsolute(p) ? p : join(repoRoot, p));

// ---- Config ----
const args = process.argv.slice(2);
const liveFlag = args.includes('--live');
const configArg = args.find(a => !a.startsWith('--'));
const configPath = configArg
  ? (isAbsolute(configArg) ? configArg : join(process.cwd(), configArg))
  : join(__dirname, 'bot.config.json');

if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}\nCopy scripts/bot.config.example.json to scripts/bot.config.json and edit it.`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
if (liveFlag) cfg.dry_run = false;

const stateFile = resolvePath(cfg.state_file || 'scripts/bot.state.json');
const logFile = resolvePath(cfg.log_file || 'scripts/bot.log');

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line.substring(0, 19) + line.substring(24)); // trim date for console readability
  try { appendFileSync(logFile, line + '\n'); } catch {}
}

// ---- State (persisted) ----
const defaultState = () => ({
  consecutiveLosses: 0,
  dayKey: null,
  dayStartEquity: null,
  halted: false,
  haltReason: null,
  dryBook: {}, // symbol -> { side, qty, entry, stop, target } (dry-run simulated positions)
});
let state = defaultState();
function loadState() {
  if (existsSync(stateFile)) {
    try { state = { ...defaultState(), ...JSON.parse(readFileSync(stateFile, 'utf8')) }; }
    catch { log('WARN could not parse state file, starting fresh'); }
  }
}
function saveState() {
  try { writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch (e) { log('WARN saveState:', e.message); }
}

// ---- Indicator math ----
function ema(values, length) {
  if (values.length < length) return null;
  const k = 2 / (length + 1);
  let e = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  for (let i = length; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
function rsi(closes, length) {
  if (closes.length < length + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= length; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let avgGain = gain / length, avgLoss = loss / length;
  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (length - 1) + Math.max(d, 0)) / length;
    avgLoss = (avgLoss * (length - 1) + Math.max(-d, 0)) / length;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function atr(bars, length) {
  if (bars.length < length + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return ema(trs, length);
}
const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function analyze(bars) {
  const closes = bars.map(b => b.close);
  const price = closes[closes.length - 1];
  const e = ema(closes, cfg.ema_length);
  const r = rsi(closes, cfg.rsi_length);
  const trendEma = cfg.use_trend_filter ? ema(closes, cfg.trend_ema_length) : null;
  const a = atr(bars, cfg.atr_length);
  const vols = bars.map(b => b.volume);
  const volMa = cfg.use_volume_filter ? avg(vols.slice(-cfg.volume_ma_length)) : null;
  const vol = vols[vols.length - 1];

  if (e == null || r == null || a == null) return { bias: 'neutral', reason: 'insufficient bars', price };

  const trendUp = trendEma == null || price > trendEma;
  const trendDown = trendEma == null || price < trendEma;
  const volOk = volMa == null || vol > volMa;

  let bias = 'neutral';
  if (price > e && r < cfg.rsi_long_max && trendUp && volOk) bias = 'long';
  else if (price < e && r > cfg.rsi_short_min && cfg.allow_short && trendDown && volOk) bias = 'short';

  return { bias, price, ema: e, rsi: r, atr: a, trendEma, trendUp, trendDown, vol, volMa, volOk };
}

// ---- Position sizing ----
function sizePosition(price, stopDistance, equity) {
  let qty = cfg.qty_per_trade;
  if (cfg.risk_per_trade_pct > 0 && equity && stopDistance > 0) {
    const riskAmount = equity * (cfg.risk_per_trade_pct / 100);
    qty = riskAmount / stopDistance; // loss at stop ≈ riskAmount (for 1 unit = 1 USD-quoted instrument)
  }
  qty = Math.min(qty, cfg.max_qty || qty);
  qty = Math.max(qty, cfg.min_qty || 0);
  // round to a sane precision
  return Math.round(qty * 1e6) / 1e6;
}

// ---- Day / halt bookkeeping ----
function rollDayIfNeeded(equity) {
  const today = new Date().toISOString().substring(0, 10);
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.dayStartEquity = equity;
    if (state.halted && state.haltReason === 'daily_loss') { state.halted = false; state.haltReason = null; }
    log(`New trading day ${today}, start equity ${equity != null ? equity.toFixed(2) : 'n/a'}`);
    saveState();
  }
}
function checkHalts(equity) {
  if (state.consecutiveLosses >= cfg.stop_after_consecutive_losses) {
    state.halted = true; state.haltReason = 'loss_streak';
  }
  if (equity != null && state.dayStartEquity != null && cfg.max_daily_loss_pct > 0) {
    const dayLossPct = ((state.dayStartEquity - equity) / state.dayStartEquity) * 100;
    if (dayLossPct >= cfg.max_daily_loss_pct) { state.halted = true; state.haltReason = 'daily_loss'; }
  }
  return state.halted;
}

// ---- Trading ----
async function ensureConnected() {
  if (cfg.dry_run) return true;
  try {
    const acct = await trading.getAccount();
    if (acct && acct.accounts?.length) return true;
  } catch {}
  log('Broker not connected — connecting Paper Trading...');
  await trading.connectPaper();
  return true;
}

async function currentEquity() {
  if (cfg.dry_run) return state.dayStartEquity || 100000; // notional for sizing in dry-run
  try { const b = await trading.getBalance(); return b.equity; } catch { return null; }
}

async function evaluateSymbol(symbol, openBySymbol, equity) {
  await chart.setSymbol({ symbol });
  await new Promise(r => setTimeout(r, 1500));
  const ohlcv = await data.getOhlcv({ count: 250 });
  const a = analyze(ohlcv.bars);
  const existing = openBySymbol[symbol]; // 'long' | 'short' | undefined
  log(`${symbol} px=${a.price} ema=${fmt(a.ema)} rsi=${fmt(a.rsi, 1)} atr=${fmt(a.atr)} trend=${a.trendUp ? 'up' : a.trendDown ? 'down' : 'flat'} vol=${a.volOk ? 'ok' : 'low'} bias=${a.bias} pos=${existing || 'flat'}`);

  // Exit if bias flipped against an open position
  if (existing && existing !== a.bias && a.bias !== 'neutral') {
    log(`  -> close ${existing} ${symbol} (bias flip -> ${a.bias})`);
    if (!cfg.dry_run) {
      const pos = (await trading.getPositions()).positions.find(p => p.symbol === symbol);
      if (pos) {
        if ((pos.unrealized_pnl || 0) < 0) state.consecutiveLosses++; else state.consecutiveLosses = 0;
        await trading.closePosition({ position_id: pos.id });
      }
    } else {
      delete state.dryBook[symbol];
    }
    delete openBySymbol[symbol];
    saveState();
  }

  // Open a new position matching bias
  if (!openBySymbol[symbol] && (a.bias === 'long' || a.bias === 'short')) {
    if (Object.keys(openBySymbol).length >= cfg.max_open_positions) {
      log(`  -> skip ${a.bias} ${symbol} (max ${cfg.max_open_positions} positions)`);
      return;
    }
    const stopDist = a.atr * cfg.atr_stop_mult;
    const isLong = a.bias === 'long';
    const stop = isLong ? a.price - stopDist : a.price + stopDist;
    const target = isLong ? a.price + stopDist * cfg.risk_reward : a.price - stopDist * cfg.risk_reward;
    const qty = sizePosition(a.price, stopDist, equity);
    log(`  -> OPEN ${a.bias} ${symbol} qty=${qty} entry~${fmt(a.price)} SL=${fmt(stop)} TP=${fmt(target)}${cfg.dry_run ? '  [dry-run]' : ''}`);
    if (!cfg.dry_run) {
      await trading.placeOrder({ symbol, side: isLong ? 'buy' : 'sell', qty, take_profit: round2(target), stop_loss: round2(stop) });
    } else {
      state.dryBook[symbol] = { side: a.bias, qty, entry: a.price, stop, target };
    }
    openBySymbol[symbol] = a.bias;
    saveState();
  }
}

async function tick() {
  loadState();
  if (state.halted) { log(`HALTED (${state.haltReason}) — skipping tick. Delete ${cfg.state_file} or resolve to resume.`); return; }

  await ensureConnected();
  const equity = await currentEquity();
  rollDayIfNeeded(equity);

  // Build the map of currently-open positions
  const openBySymbol = {};
  if (!cfg.dry_run) {
    try { const { positions } = await trading.getPositions(); for (const p of positions) openBySymbol[p.symbol] = p.side; }
    catch (e) { log('WARN getPositions:', e.message); }
  } else {
    for (const [sym, p] of Object.entries(state.dryBook)) openBySymbol[sym] = p.side;
  }

  for (const symbol of cfg.symbols) {
    try { await evaluateSymbol(symbol, openBySymbol, equity); }
    catch (err) { log(`  !! ${symbol} error: ${err.message}`); }
  }

  if (checkHalts(equity)) {
    log(`HALT: reason=${state.haltReason} consecutiveLosses=${state.consecutiveLosses} equity=${equity != null ? equity.toFixed(2) : 'n/a'} dayStart=${state.dayStartEquity != null ? state.dayStartEquity.toFixed(2) : 'n/a'}`);
    saveState();
  }
}

// ---- Helpers ----
const fmt = (n, d = 2) => (n == null ? 'n/a' : Number(n).toFixed(d));
const round2 = (n) => Math.round(n * 100) / 100;

// ---- Main loop ----
let timer = null;
async function main() {
  loadState();
  log(`Bot v2 starting | dry_run=${cfg.dry_run} symbols=${cfg.symbols.join(',')} tf=${cfg.timeframe} poll=${cfg.poll_seconds}s risk=${cfg.risk_per_trade_pct}% atrStop=${cfg.atr_stop_mult}x rr=${cfg.risk_reward}`);
  if (cfg.timeframe) { try { await chart.setTimeframe({ timeframe: cfg.timeframe }); } catch {} }
  await tick();
  timer = setInterval(() => { tick().catch(err => log('tick error:', err.message)); }, Math.max(cfg.poll_seconds, 10) * 1000);
}

async function shutdown() {
  log('Shutting down');
  if (timer) clearInterval(timer);
  saveState();
  await disconnect().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
