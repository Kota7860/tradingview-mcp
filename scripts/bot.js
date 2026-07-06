#!/usr/bin/env node
/**
 * Standalone paper-trading bot.
 *
 * Loops on its own (no Claude in the loop): for each configured symbol it reads
 * OHLCV via CDP, computes EMA + RSI, applies the same bias rules as rules.json /
 * the Pine strategy, and opens/closes PAPER positions accordingly.
 *
 * Safety:
 *   - dry_run: true (default) logs intended trades without placing them.
 *   - Only trades the Paper Trading (demo) broker; core.placeOrder refuses live.
 *   - Caps concurrent positions and stops after N consecutive losing exits.
 *
 * Usage:
 *   node scripts/bot.js                       # uses scripts/bot.config.json
 *   node scripts/bot.js path/to/config.json
 *   node scripts/bot.js --live                # overrides dry_run to actually trade paper
 *
 * TradingView Desktop must be running with --remote-debugging-port=9222.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import * as data from '../src/core/data.js';
import * as chart from '../src/core/chart.js';
import * as trading from '../src/core/trading.js';
import { disconnect } from '../src/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const log = (...a) => console.log(new Date().toISOString().substring(11, 19), ...a);

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
  for (let i = 1; i <= length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / length, avgLoss = loss / length;
  for (let i = length + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (length - 1) + Math.max(d, 0)) / length;
    avgLoss = (avgLoss * (length - 1) + Math.max(-d, 0)) / length;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function biasFor(closes) {
  const price = closes[closes.length - 1];
  const e = ema(closes, cfg.ema_length);
  const r = rsi(closes, cfg.rsi_length);
  if (e == null || r == null) return { bias: 'neutral', reason: 'not enough bars', price, ema: e, rsi: r };
  if (price > e && r < cfg.rsi_long_max) return { bias: 'long', price, ema: e, rsi: r };
  if (price < e && r > cfg.rsi_short_min && cfg.allow_short) return { bias: 'short', price, ema: e, rsi: r };
  return { bias: 'neutral', price, ema: e, rsi: r };
}

// ---- State ----
let consecutiveLosses = 0;
let stopped = false;

async function evaluateSymbol(symbol, openBySymbol) {
  await chart.setSymbol({ symbol });
  await new Promise(r => setTimeout(r, 1500));
  const ohlcv = await data.getOhlcv({ count: 200 });
  const closes = ohlcv.bars.map(b => b.close);
  const b = biasFor(closes);
  const existing = openBySymbol[symbol]; // 'long' | 'short' | undefined
  log(`${symbol}  price=${b.price}  ema=${b.ema?.toFixed(2)}  rsi=${b.rsi?.toFixed(1)}  bias=${b.bias}  pos=${existing || 'flat'}`);

  // Close a position whose bias no longer holds
  if (existing && existing !== b.bias) {
    log(`  -> close ${existing} ${symbol} (bias flipped to ${b.bias})`);
    if (!cfg.dry_run) {
      const pos = (await trading.getPositions()).positions.find(p => p.symbol === symbol);
      if (pos) {
        const before = pos.unrealized_pnl;
        await trading.closePosition({ position_id: pos.id });
        if (before < 0) consecutiveLosses++; else consecutiveLosses = 0;
      }
    }
    delete openBySymbol[symbol];
  }

  // Open a new position matching bias
  if (!openBySymbol[symbol] && (b.bias === 'long' || b.bias === 'short')) {
    const openCount = Object.keys(openBySymbol).length;
    if (openCount >= cfg.max_open_positions) {
      log(`  -> skip ${b.bias} ${symbol} (max ${cfg.max_open_positions} positions reached)`);
      return;
    }
    log(`  -> OPEN ${b.bias} ${symbol} qty=${cfg.qty_per_trade}${cfg.dry_run ? '  [dry-run]' : ''}`);
    if (!cfg.dry_run) {
      await trading.placeOrder({ symbol, side: b.bias === 'long' ? 'buy' : 'sell', qty: cfg.qty_per_trade });
    }
    openBySymbol[symbol] = b.bias;
  }
}

async function tick() {
  if (stopped) return;
  if (!cfg.dry_run) {
    const acct = await trading.getAccount().catch(() => null);
    if (!acct || !acct.accounts?.length) {
      log('Paper broker not connected — connecting...');
      await trading.connectPaper();
    }
  }
  // Map current open positions by symbol
  const openBySymbol = {};
  if (!cfg.dry_run) {
    const { positions } = await trading.getPositions().catch(() => ({ positions: [] }));
    for (const p of positions) openBySymbol[p.symbol] = p.side;
  }
  for (const symbol of cfg.symbols) {
    try { await evaluateSymbol(symbol, openBySymbol); }
    catch (err) { log(`  !! ${symbol} error: ${err.message}`); }
  }
  if (consecutiveLosses >= cfg.stop_after_consecutive_losses) {
    log(`STOP: ${consecutiveLosses} consecutive losing trades — halting per risk rules.`);
    stopped = true;
  }
}

async function main() {
  log(`Bot starting  |  dry_run=${cfg.dry_run}  symbols=${cfg.symbols.join(', ')}  tf=${cfg.timeframe}  poll=${cfg.poll_seconds}s`);
  if (cfg.timeframe) { try { await chart.setTimeframe({ timeframe: cfg.timeframe }); } catch {} }
  await tick();
  const interval = setInterval(async () => {
    if (stopped) { clearInterval(interval); await disconnect().catch(() => {}); process.exit(0); }
    await tick().catch(err => log('tick error:', err.message));
  }, Math.max(cfg.poll_seconds, 10) * 1000);
}

process.on('SIGINT', async () => { log('SIGINT — shutting down'); await disconnect().catch(() => {}); process.exit(0); });
main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
