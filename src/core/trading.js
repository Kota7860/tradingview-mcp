/**
 * Core paper trading logic via TradingView's internal trading service.
 * All functions operate on the ACTIVE broker — connect Paper Trading first
 * with connectPaper(). Works only with the Paper Trading (demo) broker unless
 * the user has deliberately connected a live broker in the TradingView UI.
 */
import { evaluate, evaluateAsync, safeString } from '../connection.js';

const TRADING = `window.TradingViewApi.trading()`;
const BROKER = `
  (function() {
    var ab = ${TRADING}.activeBroker();
    if (ab && typeof ab.value === 'function') ab = ab.value();
    return ab;
  })()
`;

// TradingView Broker API constants
const SIDE = { buy: 1, sell: -1 };
const ORDER_TYPE = { limit: 1, market: 2, stop: 3, stop_limit: 4 };

// TradingView pops a confirmation dialog for close/reverse unless this is set.
// Enabling it lets closePosition() execute programmatically instead of returning false.
async function disableTradeConfirm() {
  try {
    await evaluate(`
      (function() {
        var t = ${TRADING};
        if (t.noConfirmEnabled && typeof t.noConfirmEnabled.setValue === 'function') t.noConfirmEnabled.setValue(true);
      })()
    `);
  } catch {}
}

async function getStatus() {
  return evaluate(`
    (function() {
      var t = ${TRADING};
      var ab = ${BROKER};
      var cs = null;
      try { cs = t.connectStatus(); cs = (cs && typeof cs.value === 'function') ? cs.value() : cs; } catch(e) {}
      var out = { broker_connected: !!ab, connect_status: cs };
      if (ab) { try { var mi = ab.metainfo ? ab.metainfo() : null; out.broker_id = mi ? (mi.id || mi.title) : null; } catch(e) {} }
      return out;
    })()
  `);
}

export async function connectPaper() {
  const before = await getStatus();
  // connect_status 1 = connected
  if (before.broker_connected && before.connect_status === 1) {
    return { success: true, already_connected: true, ...before };
  }

  // Open the trading widget so the broker picker renders
  await evaluate(`(function(){ try { ${TRADING}.toggleTradingWidget(); } catch(e) {} })()`);
  await new Promise(r => setTimeout(r, 2500));

  // Click the Paper Trading card if the broker picker is showing
  await evaluate(`
    (function() {
      var els = document.querySelectorAll('div, a, button');
      for (var i = 0; i < els.length; i++) {
        var txt = (els[i].textContent || '').trim();
        if (txt.indexOf('Paper Trading') === 0 && txt.indexOf('Brokerage simulator') !== -1 && txt.length < 150) { els[i].click(); return true; }
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 3000));

  // Click Connect
  await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent || '').trim() === 'Connect') { btns[i].click(); return true; }
      }
      return false;
    })()
  `);
  await new Promise(r => setTimeout(r, 5000));

  const after = await getStatus();
  if (!after.broker_connected || after.connect_status !== 1) {
    throw new Error(`Paper Trading did not connect (status ${after.connect_status}). Make sure you are logged in to TradingView, then retry.`);
  }
  await disableTradeConfirm();
  return { success: true, connected: true, ...after };
}

export async function getAccount() {
  const status = await getStatus();
  if (!status.broker_connected) throw new Error('No broker connected. Use trade_connect_paper first.');
  const accounts = await evaluateAsync(`
    (function() {
      var ab = ${BROKER};
      return Promise.resolve(ab.accountsMetainfo()).then(function(list) {
        return (list || []).map(function(a) { return { id: a.id, name: a.name, type: a.type, title: a.title, currency: a.currency }; });
      });
    })()
  `);
  return { success: true, connect_status: status.connect_status, broker_id: status.broker_id, accounts };
}

export async function getPositions() {
  const status = await getStatus();
  if (!status.broker_connected) throw new Error('No broker connected. Use trade_connect_paper first.');
  const positions = await evaluateAsync(`
    (function() {
      var ab = ${BROKER};
      return Promise.resolve(ab.positions()).then(function(list) {
        return (list || []).filter(function(p) { return Math.abs(p.qty) > 0; }).map(function(p) {
          return { id: p.id, symbol: p.symbol, side: p.side === 1 ? 'long' : 'short', qty: p.qty, avg_price: p.avgPrice, last_price: p.lastPrice, unrealized_pnl: p.pl, take_profit: p.takeProfit, stop_loss: p.stopLoss };
        });
      });
    })()
  `);
  return { success: true, position_count: positions.length, positions };
}

// TradingView Broker OrderStatus enum
const ORDER_STATUS = { 1: 'canceled', 2: 'filled', 3: 'inactive', 4: 'placing', 5: 'rejected', 6: 'working' };
const ORDER_TYPE_NAME = { 1: 'limit', 2: 'market', 3: 'stop', 4: 'stop_limit' };
const WORKING_STATUSES = new Set([4, 6]); // placing, working

export async function getOrders({ include_history, all } = {}) {
  const status = await getStatus();
  if (!status.broker_connected) throw new Error('No broker connected. Use trade_connect_paper first.');
  const orders = await evaluateAsync(`
    (function() {
      var ab = ${BROKER};
      var fetch = ${include_history ? 'ab.ordersHistory()' : 'ab.orders()'};
      return Promise.resolve(fetch).then(function(list) {
        return (list || []).slice(0, 100).map(function(o) {
          return { id: o.id, symbol: o.symbol, side: o.side === 1 ? 'buy' : 'sell', qty: o.qty, type: o.type, status: o.status, limit_price: o.limitPrice, stop_price: o.stopPrice, avg_price: o.avgPrice, take_profit: o.takeProfit, stop_loss: o.stopLoss, placing_time: o.placingTime };
        });
      });
    })()
  `);
  // Default: only live/working orders. include_history or all=true returns everything.
  const shown = (include_history || all) ? orders : orders.filter(o => WORKING_STATUSES.has(o.status));
  const decorated = shown.map(o => ({
    ...o,
    type: ORDER_TYPE_NAME[o.type] || o.type,
    status: ORDER_STATUS[o.status] || o.status,
  }));
  return { success: true, order_count: decorated.length, filter: (include_history || all) ? 'all' : 'working_only', orders: decorated };
}

export async function getBalance() {
  const status = await getStatus();
  if (!status.broker_connected) throw new Error('No broker connected. Use trade_connect_paper first.');
  // Live equity + available margin come via subscription callbacks: cb(metricName, value, extra)
  const funds = await evaluateAsync(`
    (function() {
      var ab = ${BROKER};
      return new Promise(function(resolve) {
        var out = {};
        var done = setTimeout(function() { resolve(out); }, 4000);
        try { ab.subscribeEquity(function(_id, v) { out.equity = v; if (out.available_funds != null) { clearTimeout(done); resolve(out); } }); } catch(e) { out.equity_error = e.message; }
        try { ab.subscribeMarginAvailable(function(_id, v) { out.available_funds = v; if (out.equity != null) { clearTimeout(done); resolve(out); } }); } catch(e) { out.margin_error = e.message; }
      });
    })()
  `);
  // Unrealized PnL from open positions; balance = equity - unrealized
  const { positions } = await getPositions();
  const unrealized = positions.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0);
  const equity = funds.equity;
  const round = (n) => n == null ? null : Math.round(n * 100) / 100;
  return {
    success: true,
    equity: round(equity),
    available_funds: round(funds.available_funds),
    unrealized_pnl: round(unrealized),
    balance: round(equity != null ? equity - unrealized : null),
    open_positions: positions.length,
    currency: 'USD',
  };
}

export async function modifyOrder({ order_id, limit_price, stop_price, take_profit, stop_loss, qty }) {
  const status = await getStatus();
  if (!status.broker_connected) throw new Error('No broker connected. Use trade_connect_paper first.');
  if (!order_id) throw new Error('order_id is required');
  if (status.broker_id && !/paper/i.test(String(status.broker_id))) {
    throw new Error(`Refusing to modify order: active broker is "${status.broker_id}", not Paper Trading.`);
  }
  const changes = {};
  if (limit_price != null) changes.limitPrice = Number(limit_price);
  if (stop_price != null) changes.stopPrice = Number(stop_price);
  if (take_profit != null) changes.takeProfit = Number(take_profit);
  if (stop_loss != null) changes.stopLoss = Number(stop_loss);
  if (qty != null) changes.qty = Number(qty);
  if (Object.keys(changes).length === 0) throw new Error('Provide at least one field to modify (limit_price, stop_price, take_profit, stop_loss, qty)');

  // modifyOrder requires the FULL order object with changes merged in, not just the deltas.
  const result = await evaluateAsync(`
    (function() {
      var ab = ${BROKER};
      return Promise.resolve(ab.orders()).then(function(list) {
        var order = (list || []).filter(function(o) { return String(o.id) === ${safeString(String(order_id))}; })[0];
        if (!order) return { error: 'Order not found or no longer working: ' + ${safeString(String(order_id))} };
        var merged = Object.assign({}, order, ${JSON.stringify(changes)});
        return Promise.resolve(ab.modifyOrder(merged)).then(function(ok) { return { ok: !!ok }; });
      });
    })()
  `);
  if (result && result.error) throw new Error(result.error);
  return { success: true, modified: order_id, applied: result?.ok !== false, changes };
}

export async function placeOrder({ symbol, side, qty, type, limit_price, stop_price, take_profit, stop_loss }) {
  const status = await getStatus();
  if (!status.broker_connected) throw new Error('No broker connected. Use trade_connect_paper first.');
  if (status.broker_id && !/paper/i.test(String(status.broker_id))) {
    throw new Error(`Refusing to place order: active broker is "${status.broker_id}", not Paper Trading. This tool only trades on the paper (demo) account.`);
  }
  const sideNum = SIDE[side];
  if (!sideNum) throw new Error('side must be "buy" or "sell"');
  const typeNum = ORDER_TYPE[type || 'market'];
  if (!typeNum) throw new Error('type must be one of: market, limit, stop, stop_limit');
  if (!(qty > 0)) throw new Error('qty must be > 0');
  if ((typeNum === 1 || typeNum === 4) && !(limit_price > 0)) throw new Error('limit_price required for limit orders');
  if ((typeNum === 3 || typeNum === 4) && !(stop_price > 0)) throw new Error('stop_price required for stop orders');

  const result = await evaluateAsync(`
    (function() {
      var ab = ${BROKER};
      var sym = ${safeString(symbol || '')};
      var symPromise = sym ? Promise.resolve(sym) : Promise.resolve(window.TradingViewApi.activeChart().symbol());
      return symPromise.then(function(s) {
        var preOrder = {
          symbol: s,
          side: ${sideNum},
          type: ${typeNum},
          qty: ${Number(qty)},
          ${limit_price ? `limitPrice: ${Number(limit_price)},` : ''}
          ${stop_price ? `stopPrice: ${Number(stop_price)},` : ''}
          ${take_profit ? `takeProfit: ${Number(take_profit)},` : ''}
          ${stop_loss ? `stopLoss: ${Number(stop_loss)},` : ''}
        };
        return Promise.resolve(ab.placeOrder(preOrder)).then(function(r) {
          return { placed: true, order_id: r && r.orderId ? r.orderId : null, symbol: s };
        });
      });
    })()
  `);
  return { success: true, ...result, side, qty, type: type || 'market' };
}

export async function closePosition({ position_id }) {
  const status = await getStatus();
  if (!status.broker_connected) throw new Error('No broker connected. Use trade_connect_paper first.');
  await disableTradeConfirm();
  if (!position_id) {
    // close all
    const { positions } = await getPositions();
    if (positions.length === 0) return { success: true, closed: 0, note: 'No open positions' };
    const results = [];
    for (const p of positions) {
      try {
        await evaluateAsync(`Promise.resolve(${BROKER}.closePosition(${safeString(p.id)}))`);
        results.push({ id: p.id, symbol: p.symbol, closed: true });
      } catch (err) {
        results.push({ id: p.id, symbol: p.symbol, closed: false, error: err.message });
      }
    }
    return { success: true, closed: results.filter(r => r.closed).length, results };
  }
  await evaluateAsync(`Promise.resolve(${BROKER}.closePosition(${safeString(position_id)}))`);
  return { success: true, closed: 1, position_id };
}

export async function cancelOrder({ order_id }) {
  const status = await getStatus();
  if (!status.broker_connected) throw new Error('No broker connected. Use trade_connect_paper first.');
  if (!order_id) throw new Error('order_id is required');
  await evaluateAsync(`Promise.resolve(${BROKER}.cancelOrder(${safeString(order_id)}))`);
  return { success: true, cancelled: order_id };
}
