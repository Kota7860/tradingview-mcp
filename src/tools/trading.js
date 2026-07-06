import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/trading.js';

export function registerTradingTools(server) {
  server.tool('trade_connect_paper', 'Connect the TradingView Paper Trading (demo) broker. Requires being logged in to TradingView. Safe: paper money only.', {}, async () => {
    try { return jsonResult(await core.connectPaper()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trade_account', 'Get connected trading account info (broker, account id, currency)', {}, async () => {
    try { return jsonResult(await core.getAccount()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trade_positions', 'List open positions with side, qty, avg price, and unrealized PnL', {}, async () => {
    try { return jsonResult(await core.getPositions()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trade_orders', 'List working orders only (default). Use all=true for every order incl. filled/canceled, or include_history=true for order history. Status and type are human-readable.', {
    all: z.coerce.boolean().optional().describe('Return all orders (working + filled + canceled), not just working'),
    include_history: z.coerce.boolean().optional().describe('Return order history instead of the live order list'),
  }, async ({ all, include_history }) => {
    try { return jsonResult(await core.getOrders({ all, include_history })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trade_balance', 'Get account balance, equity, available funds, and total unrealized PnL', {}, async () => {
    try { return jsonResult(await core.getBalance()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trade_modify', 'Modify a working order: change limit/stop price, take-profit, stop-loss, or quantity. Paper account only.', {
    order_id: z.string().describe('Order ID from trade_orders'),
    limit_price: z.coerce.number().optional().describe('New limit price'),
    stop_price: z.coerce.number().optional().describe('New stop price'),
    take_profit: z.coerce.number().optional().describe('New take-profit price'),
    stop_loss: z.coerce.number().optional().describe('New stop-loss price'),
    qty: z.coerce.number().optional().describe('New quantity'),
  }, async (args) => {
    try { return jsonResult(await core.modifyOrder(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trade_place', 'Place an order on the Paper Trading account. Refuses to run against a live broker. Market orders execute immediately.', {
    side: z.enum(['buy', 'sell']).describe('Order side'),
    qty: z.coerce.number().positive().describe('Quantity (units of the instrument)'),
    symbol: z.string().optional().describe('Symbol (blank = current chart symbol)'),
    type: z.enum(['market', 'limit', 'stop', 'stop_limit']).optional().describe('Order type (default market)'),
    limit_price: z.coerce.number().optional().describe('Limit price (required for limit / stop_limit)'),
    stop_price: z.coerce.number().optional().describe('Stop price (required for stop / stop_limit)'),
    take_profit: z.coerce.number().optional().describe('Take-profit price attached to the order'),
    stop_loss: z.coerce.number().optional().describe('Stop-loss price attached to the order'),
  }, async (args) => {
    try { return jsonResult(await core.placeOrder(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trade_close', 'Close an open position by ID, or ALL positions if no ID given', {
    position_id: z.string().optional().describe('Position ID from trade_positions (blank = close all)'),
  }, async ({ position_id }) => {
    try { return jsonResult(await core.closePosition({ position_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('trade_cancel', 'Cancel a working order by ID', {
    order_id: z.string().describe('Order ID from trade_orders'),
  }, async ({ order_id }) => {
    try { return jsonResult(await core.cancelOrder({ order_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
