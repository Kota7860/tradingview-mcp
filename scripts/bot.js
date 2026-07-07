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
import { createServer } from 'http';
import { request as httpsRequest } from 'https';
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
const journalFile = resolvePath(cfg.journal_file || 'scripts/bot.trades.csv');

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
  // symbol -> { side, qty, entry, stop, target, source, openTime, initStopDist, slAtBE }
  // Metadata for bot-managed positions in BOTH live and dry-run modes.
  openTrades: {},
  stats: { trades: 0, wins: 0, losses: 0, pnl: 0, sumR: 0 },
  tradesToday: 0,
  tradesDayKey: null,
  lastExit: {}, // symbol -> epoch ms of last close (for cooldown)
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

// ---- Notifications (Telegram / Discord), fire-and-forget ----
function postJson(url, payload) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const body = JSON.stringify(payload);
      const req = httpsRequest({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', (e) => { log('WARN notify:', e.message); resolve(); });
      req.write(body); req.end();
    } catch (e) { log('WARN notify:', e.message); resolve(); }
  });
}
function notify(text) {
  const n = cfg.notify || {};
  if (n.telegram && n.telegram.enabled && n.telegram.bot_token && n.telegram.chat_id) {
    postJson(`https://api.telegram.org/bot${n.telegram.bot_token}/sendMessage`, { chat_id: n.telegram.chat_id, text });
  }
  if (n.discord && n.discord.enabled && n.discord.webhook_url) {
    postJson(n.discord.webhook_url, { content: text });
  }
}

// ---- Trade journal ----
function journalTrade(row) {
  const header = 'close_time,symbol,side,qty,entry,exit,stop,pnl,R,source,reason\n';
  if (!existsSync(journalFile)) { try { writeFileSync(journalFile, header); } catch {} }
  const line = [new Date().toISOString(), row.symbol, row.side, row.qty, fmt(row.entry), fmt(row.exit), fmt(row.stop), fmt(row.pnl, 4), fmt(row.R, 2), row.source, row.reason].join(',') + '\n';
  try { appendFileSync(journalFile, line); } catch (e) { log('WARN journal:', e.message); }
}
function recordStats(pnl, R) {
  const s = state.stats;
  s.trades++; s.pnl += pnl; s.sumR += (R || 0);
  if (pnl >= 0) s.wins++; else s.losses++;
}
function statsSummary() {
  const s = state.stats || { trades: 0, wins: 0, losses: 0, pnl: 0, sumR: 0 };
  const wr = s.trades ? (s.wins / s.trades * 100) : 0;
  const avgR = s.trades ? (s.sumR / s.trades) : 0;
  return `trades=${s.trades} win%=${wr.toFixed(0)} pnl=${fmt(s.pnl)} avgR=${avgR.toFixed(2)}`;
}

// ---- Discipline guards ----
function minutesNowInTz(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
    const h = +parts.find(p => p.type === 'hour').value;
    const m = +parts.find(p => p.type === 'minute').value;
    return (h % 24) * 60 + m;
  } catch { return null; }
}
function parseHM(s) { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); }
function sessionOk() {
  const sf = cfg.session_filter;
  if (!sf || !sf.enabled) return true;
  const now = minutesNowInTz(sf.timezone || 'UTC');
  if (now == null) return true;
  const start = parseHM(sf.start || '00:00');
  const end = parseHM(sf.end || '23:59');
  const inWin = start <= end ? (now >= start && now <= end) : (now >= start || now <= end);
  if (!inWin) return false;
  if (sf.skip_open_minutes && now >= start && now < start + sf.skip_open_minutes) return false;
  return true;
}
function rollTradesDay() {
  const today = new Date().toISOString().substring(0, 10);
  if (state.tradesDayKey !== today) { state.tradesDayKey = today; state.tradesToday = 0; }
}
// Returns { ok, reason } — checks that a NEW entry is allowed right now.
function entryGuards(symbol) {
  if (!sessionOk()) return { ok: false, reason: 'outside_session' };
  rollTradesDay();
  if (cfg.max_trades_per_day > 0 && state.tradesToday >= cfg.max_trades_per_day) return { ok: false, reason: 'max_trades_day' };
  const last = (state.lastExit || {})[symbol];
  if (cfg.cooldown_seconds > 0 && last && (Date.now() - last) < cfg.cooldown_seconds * 1000) return { ok: false, reason: 'cooldown' };
  return { ok: true };
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

// Close an open position for a symbol: compute PnL, journal it, update stats,
// loss streak, cooldown, and notify.
async function closeSymbol(symbol, openBySymbol, reason = 'signal') {
  const meta = state.openTrades[symbol] || null;
  let pnl = null, exitPrice = null;

  if (!cfg.dry_run) {
    const pos = (await trading.getPositions()).positions.find(p => p.symbol === symbol);
    if (pos) {
      pnl = pos.unrealized_pnl || 0;
      exitPrice = pos.last_price;
      await trading.closePosition({ position_id: pos.id });
    }
  } else if (meta) {
    // Mark-to-market with a fresh quote for the exit price.
    try { const q = await data.getQuote({ symbol }); exitPrice = q.last ?? q.close; } catch {}
    if (exitPrice != null) pnl = (meta.side === 'long' ? exitPrice - meta.entry : meta.entry - exitPrice) * meta.qty;
    delete state.dryBook?.[symbol];
  }

  if (meta && pnl != null) {
    const risk = (meta.initStopDist || Math.abs(meta.entry - meta.stop)) * meta.qty;
    const R = risk > 0 ? pnl / risk : 0;
    journalTrade({ symbol, side: meta.side, qty: meta.qty, entry: meta.entry, exit: exitPrice, stop: meta.stop, pnl, R, source: meta.source, reason });
    recordStats(pnl, R);
    state.consecutiveLosses = pnl < 0 ? state.consecutiveLosses + 1 : 0;
    log(`  = CLOSE ${meta.side} ${symbol} exit~${fmt(exitPrice)} pnl=${fmt(pnl, 4)} R=${R.toFixed(2)} (${reason}) | ${statsSummary()}`);
    notify(`CLOSE ${meta.side} ${symbol} @ ${fmt(exitPrice)} | pnl ${fmt(pnl, 2)} (R ${R.toFixed(2)}) | ${reason}`);
  }

  delete state.openTrades[symbol];
  delete openBySymbol[symbol];
  state.lastExit = state.lastExit || {};
  state.lastExit[symbol] = Date.now();
  saveState();
}

// Break-even + ATR trailing for an open position. Uses the current price/ATR
// already fetched for this symbol. Live: modifies the bracket stop order.
async function managePosition(symbol, side, price, atrVal, openBySymbol) {
  if (!cfg.manage_positions) return;
  const meta = state.openTrades[symbol];
  if (!meta) return;
  const isLong = side === 'long';
  const initDist = meta.initStopDist || Math.abs(meta.entry - meta.stop);
  const profitR = initDist > 0 ? (isLong ? price - meta.entry : meta.entry - price) / initDist : 0;

  let newStop = meta.stop;
  if ((cfg.be_at_r ?? 0) > 0 && !meta.slAtBE && profitR >= cfg.be_at_r) { newStop = meta.entry; meta.slAtBE = true; }
  if (cfg.trail_enabled && profitR > 0 && atrVal) {
    const trail = isLong ? price - atrVal * (cfg.trail_atr_mult ?? 2) : price + atrVal * (cfg.trail_atr_mult ?? 2);
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  const improved = isLong ? newStop > meta.stop : newStop < meta.stop;
  if (!improved) return;

  if (!cfg.dry_run) {
    try {
      const orders = (await trading.getOrders({})).orders;
      const slOrder = orders.find(o => o.symbol === symbol && o.type === 'stop' && o.side === (isLong ? 'sell' : 'buy'));
      if (slOrder) await trading.modifyOrder({ order_id: slOrder.id, stop_price: round2(newStop) });
    } catch (e) { log(`  ~ manage ${symbol} modify failed: ${e.message}`); return; }
  }
  log(`  ~ manage ${symbol}: SL ${fmt(meta.stop)} -> ${fmt(newStop)} (R=${profitR.toFixed(2)}${meta.slAtBE ? ' BE' : ''})`);
  meta.stop = newStop;
  saveState();
}

// Shared entry logic used by BOTH the poll loop and the webhook. Enforces
// halt, position caps, dedupe, and reverses on an opposite-side signal.
async function openSignal({ symbol, side, entry, stop, target }, openBySymbol, equity, source) {
  const sideNorm = (side === 'buy' || side === 'long') ? 'long' : 'short';
  if (state.halted) { log(`  -> reject ${sideNorm} ${symbol}: halted (${state.haltReason}) [${source}]`); return { ok: false, reason: 'halted' }; }

  const existing = openBySymbol[symbol];
  if (existing === sideNorm) { log(`  -> skip ${sideNorm} ${symbol}: already ${existing} [${source}]`); return { ok: false, reason: 'already_open' }; }
  if (existing && existing !== sideNorm) {
    log(`  -> reverse ${symbol}: close ${existing} then open ${sideNorm} [${source}]`);
    await closeSymbol(symbol, openBySymbol, 'reverse');
  }
  if (Object.keys(openBySymbol).length >= cfg.max_open_positions) {
    log(`  -> skip ${sideNorm} ${symbol}: max ${cfg.max_open_positions} positions [${source}]`);
    return { ok: false, reason: 'max_positions' };
  }
  const guard = entryGuards(symbol);
  if (!guard.ok) { log(`  -> skip ${sideNorm} ${symbol}: ${guard.reason} [${source}]`); return { ok: false, reason: guard.reason }; }

  const stopDist = Math.abs(entry - stop);
  const qty = sizePosition(entry, stopDist, equity);
  log(`  -> OPEN ${sideNorm} ${symbol} qty=${qty} entry~${fmt(entry)} SL=${fmt(stop)} TP=${fmt(target)} [${source}]${cfg.dry_run ? ' [dry-run]' : ''}`);
  if (!cfg.dry_run) {
    await trading.placeOrder({ symbol, side: sideNorm === 'long' ? 'buy' : 'sell', qty, take_profit: round2(target), stop_loss: round2(stop) });
  }
  state.openTrades[symbol] = { side: sideNorm, qty, entry, stop, target, source, openTime: Date.now(), initStopDist: stopDist, slAtBE: false };
  openBySymbol[symbol] = sideNorm;
  rollTradesDay();
  state.tradesToday++;
  saveState();
  notify(`OPEN ${sideNorm} ${symbol} qty ${qty} @ ${fmt(entry)} | SL ${fmt(stop)} TP ${fmt(target)} [${source}]${cfg.dry_run ? ' (dry)' : ''}`);
  return { ok: true, side: sideNorm, qty, entry, stop, target };
}

// Read FPU-MAX-V5's live composite bias / verdict / regime from its on-chart
// panel (works for the currently-loaded chart symbol). Returns null if absent.
async function readFpuBias() {
  const t = await data.getPineTables({ study_filter: cfg.fpu_study_filter || 'MAX' });
  const st = (t.studies || [])[0];
  if (!st || !st.tables) return null;
  let composite = null, verdict = null, regime = null;
  for (const tbl of st.tables) {
    for (const row of (tbl.rows || [])) {
      const parts = String(row).split('|').map(s => s.trim());
      const k = parts[0], v = parts[1];
      if (/^COMPOSITE/i.test(k)) composite = parseFloat(v);
      else if (/^VERDICT/i.test(k)) verdict = v;
      else if (/^REGIME/i.test(k)) regime = v;
    }
  }
  if (composite == null) return null;
  return { composite, verdict, regime };
}

function fpuToBias(fpu) {
  if (!fpu) return 'neutral';
  const regimeOk = !cfg.fpu_regime_filter || fpu.regime === 'TRENDING' || fpu.regime === 'MIXED';
  if (!regimeOk) return 'neutral';
  if (fpu.composite >= (cfg.fpu_bull ?? 65)) return 'long';
  if (fpu.composite <= (cfg.fpu_bear ?? 35) && cfg.allow_short) return 'short';
  return 'neutral';
}

// Combine the bot's own bias with FPU's bias. Rules:
//   all_agree — trade only when both say the same direction (confluence)
//   either    — trade if either fires and the other doesn't oppose
function combineBias(internal, fpu, rule = 'all_agree') {
  if (rule === 'either') {
    if ((internal === 'long' || fpu === 'long') && internal !== 'short' && fpu !== 'short') return 'long';
    if ((internal === 'short' || fpu === 'short') && internal !== 'long' && fpu !== 'long') return 'short';
    return 'neutral';
  }
  // all_agree (default)
  if (internal === fpu && (internal === 'long' || internal === 'short')) return internal;
  return 'neutral';
}

async function evaluateSymbol(symbol, openBySymbol, equity) {
  const usesFpu = cfg.signal_source === 'fpu' || cfg.signal_source === 'combined';
  await chart.setSymbol({ symbol });
  await new Promise(r => setTimeout(r, usesFpu ? 2500 : 1500));
  const ohlcv = await data.getOhlcv({ count: 250 });
  const a = analyze(ohlcv.bars); // price + ATR always; internal bias

  // Bias source: internal indicators, FPU-MAX-V5 on the chart, or both combined.
  let bias = a.bias;
  let detail = `ema=${fmt(a.ema)} rsi=${fmt(a.rsi, 1)} trend=${a.trendUp ? 'up' : a.trendDown ? 'down' : 'flat'} vol=${a.volOk ? 'ok' : 'low'} bias=${bias}`;
  if (usesFpu) {
    const fpu = await readFpuBias();
    const fpuBias = fpuToBias(fpu);
    const fpuStr = fpu ? `fpu=${fpu.composite}%/${fpu.verdict}/${fpu.regime}->${fpuBias}` : 'fpu=unavailable->neutral';
    if (cfg.signal_source === 'fpu') {
      bias = fpuBias;
      detail = fpuStr;
    } else { // combined
      bias = combineBias(a.bias, fpuBias, cfg.combine_rule || 'all_agree');
      detail = `internal=${a.bias} ${fpuStr} [${cfg.combine_rule || 'all_agree'}]-> ${bias}`;
    }
  }

  const existing = openBySymbol[symbol]; // 'long' | 'short' | undefined
  log(`${symbol} px=${a.price} atr=${fmt(a.atr)} ${detail} pos=${existing || 'flat'}`);

  // Manage an existing position (break-even / trailing) using this tick's price+ATR
  if (existing) await managePosition(symbol, existing, a.price, a.atr, openBySymbol);

  // Exit if bias flipped against an open position
  if (existing && existing !== bias && bias !== 'neutral') {
    log(`  -> close ${existing} ${symbol} (bias flip -> ${bias})`);
    await closeSymbol(symbol, openBySymbol, 'bias_flip');
  }

  // Open a new position matching bias (ATR-based SL/TP either way)
  if (!openBySymbol[symbol] && (bias === 'long' || bias === 'short')) {
    const stopDist = a.atr * cfg.atr_stop_mult;
    const isLong = bias === 'long';
    const stop = isLong ? a.price - stopDist : a.price + stopDist;
    const target = isLong ? a.price + stopDist * cfg.risk_reward : a.price - stopDist * cfg.risk_reward;
    await openSignal({ symbol, side: bias, entry: a.price, stop, target }, openBySymbol, equity, cfg.signal_source || 'poll');
  }
}

async function tick() {
  loadState();
  if (state.halted) { log(`HALTED (${state.haltReason}) — skipping tick. Delete ${cfg.state_file} or resolve to resume.`); return; }

  await ensureConnected();
  const equity = await currentEquity();
  rollDayIfNeeded(equity);

  // Build the map of currently-open positions
  const openBySymbol = await currentOpenMap();

  for (const symbol of cfg.symbols) {
    try { await evaluateSymbol(symbol, openBySymbol, equity); }
    catch (err) { log(`  !! ${symbol} error: ${err.message}`); }
  }

  if (checkHalts(equity)) {
    const m = `HALT: reason=${state.haltReason} consecutiveLosses=${state.consecutiveLosses} equity=${equity != null ? equity.toFixed(2) : 'n/a'} dayStart=${state.dayStartEquity != null ? state.dayStartEquity.toFixed(2) : 'n/a'} | ${statsSummary()}`;
    log(m);
    notify(m);
    saveState();
  }
}

// ---- Helpers ----
const fmt = (n, d = 2) => (n == null ? 'n/a' : Number(n).toFixed(d));
const round2 = (n) => Math.round(n * 100) / 100;

// Build the current open-position map (live positions or the dry-run book).
async function currentOpenMap() {
  const openBySymbol = {};
  if (!cfg.dry_run) {
    try { const { positions } = await trading.getPositions(); for (const p of positions) openBySymbol[p.symbol] = p.side; }
    catch (e) { log('WARN getPositions:', e.message); }
  } else {
    for (const [sym, p] of Object.entries(state.openTrades)) openBySymbol[sym] = p.side;
  }
  return openBySymbol;
}

// ---- Webhook listener ----
// Consumes the JSON alert emitted by FPU-MAX-V5 (or any alert with the same
// shape): {symbol, tf, signal:"long"|"short"|"close", price, entry, sl, tp1, ...}
let webhookServer = null;
function startHttpServer() {
  const port = cfg.webhook_port || 8080;
  const host = cfg.webhook_host || '127.0.0.1';
  const path = cfg.webhook_path || '/tv-webhook';
  const statusPath = cfg.status_path || '/status';
  const map = cfg.webhook_symbol_map || {};

  webhookServer = createServer((req, res) => {
    // Status endpoint (read-only snapshot)
    if (req.method === 'GET' && cfg.status_enabled && req.url === statusPath) {
      loadState();
      const snapshot = {
        dry_run: cfg.dry_run, signal_source: cfg.signal_source || 'internal',
        halted: state.halted, haltReason: state.haltReason,
        tradesToday: state.tradesToday, stats: state.stats,
        open_positions: Object.keys(state.openTrades || {}).length,
        openTrades: state.openTrades,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot, null, 2));
      return;
    }
    if (req.method !== 'POST' || req.url !== path || !cfg.webhook_enabled) {
      res.writeHead(404); res.end('not found'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let ok = false, msg = 'error';
      try {
        const p = JSON.parse(body);
        // Optional shared secret: include "secret" in the alert JSON to use it.
        if (cfg.webhook_secret && p.secret !== cfg.webhook_secret) {
          log(`WEBHOOK rejected: bad/missing secret from ${req.socket.remoteAddress}`);
          res.writeHead(401); res.end('unauthorized'); return;
        }
        const rawSym = String(p.symbol || '').trim();
        const symbol = map[rawSym] || rawSym; // map "BTCUSD" -> "BITSTAMP:BTCUSD" etc
        const sig = String(p.signal || '').toLowerCase();
        if (!symbol || !['long', 'short', 'buy', 'sell', 'close'].includes(sig)) {
          res.writeHead(400); res.end('bad payload'); return;
        }
        log(`WEBHOOK ${sig} ${symbol} price=${p.price ?? '?'} composite=${p.composite ?? '?'} regime=${p.regime ?? '?'}`);

        loadState();
        if (state.halted) { res.writeHead(200); res.end('halted'); return; }
        await ensureConnected();
        const equity = await currentEquity();
        rollDayIfNeeded(equity);
        const openBySymbol = await currentOpenMap();

        if (sig === 'close') {
          await closeSymbol(symbol, openBySymbol);
          ok = true; msg = 'closed';
        } else {
          const isLong = sig === 'long' || sig === 'buy';
          const entry = Number(p.entry ?? p.price);
          // Use alert-provided SL/TP; fall back to ATR-style defaults from entry if absent.
          const fallbackDist = entry * 0.01;
          const stop = Number(p.sl ?? (isLong ? entry - fallbackDist : entry + fallbackDist));
          const target = Number(p.tp1 ?? (isLong ? entry + fallbackDist * cfg.risk_reward : entry - fallbackDist * cfg.risk_reward));
          if (!(entry > 0)) { res.writeHead(400); res.end('no entry price'); return; }
          const r = await openSignal({ symbol, side: isLong ? 'long' : 'short', entry, stop, target }, openBySymbol, equity, 'webhook');
          ok = r.ok; msg = r.ok ? 'opened' : r.reason;
        }
        checkHalts(equity);
      } catch (err) {
        log(`WEBHOOK error: ${err.message}`);
        res.writeHead(400); res.end('error: ' + err.message); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, result: msg }));
    });
  });

  webhookServer.on('error', (e) => log(`HTTP server error: ${e.message}`));
  webhookServer.listen(port, host, () => {
    const routes = [cfg.webhook_enabled ? `POST ${path}` : null, cfg.status_enabled ? `GET ${statusPath}` : null].filter(Boolean).join(', ');
    log(`HTTP server on http://${host}:${port} (${routes})  (dry_run=${cfg.dry_run})`);
    if (cfg.webhook_enabled && host === '127.0.0.1') log('  note: TradingView is cloud-hosted — expose this via a tunnel (e.g. ngrok) for live TV alerts, or POST locally to test.');
  });
}

// ---- Main loop ----
let timer = null;
async function main() {
  loadState();
  const pollOn = cfg.poll_enabled !== false;
  log(`Bot v2 starting | dry_run=${cfg.dry_run} poll=${pollOn ? cfg.poll_seconds + 's' : 'off'} webhook=${cfg.webhook_enabled ? 'on' : 'off'} symbols=${cfg.symbols.join(',')} tf=${cfg.timeframe} risk=${cfg.risk_per_trade_pct}% atrStop=${cfg.atr_stop_mult}x rr=${cfg.risk_reward}`);

  if (cfg.webhook_enabled || cfg.status_enabled) startHttpServer();

  if (pollOn) {
    if (cfg.timeframe) { try { await chart.setTimeframe({ timeframe: cfg.timeframe }); } catch {} }
    await tick();
    timer = setInterval(() => { tick().catch(err => log('tick error:', err.message)); }, Math.max(cfg.poll_seconds, 10) * 1000);
  } else if (!cfg.webhook_enabled) {
    log('Nothing to do: poll_enabled and webhook_enabled are both off. Exiting.');
    process.exit(0);
  }
}

async function shutdown() {
  log('Shutting down');
  if (timer) clearInterval(timer);
  if (webhookServer) webhookServer.close();
  saveState();
  await disconnect().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
