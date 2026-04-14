import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP connection to TradingView and return current chart state', {}, async () => {
    try { return jsonResult(await core.healthCheck()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.' }, true); }
  });

  server.tool('tv_discover', 'Report which known TradingView API paths are available and their methods', {}, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {}, async () => {
    try { return jsonResult(await core.uiState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_launch', 'Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled. Auto-detects install location on Mac, Windows, and Linux.', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView instances first (default true)'),
  }, async ({ port, kill_existing }) => {
    try { return jsonResult(await core.launch({ port, kill_existing })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_launch_web', 'Launch Chrome/Chromium browser with TradingView web app and CDP enabled. Use this instead of tv_launch when running on a server or VPS without TradingView Desktop installed. Supports headless mode for cloud deployments.', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    chart_url: z.string().optional().describe('TradingView chart URL (default https://www.tradingview.com/chart/)'),
    headless: z.coerce.boolean().optional().describe('Run Chrome headless (default true — set false to see the browser window)'),
  }, async ({ port, chart_url, headless }) => {
    try { return jsonResult(await core.launchWeb({ port, chart_url, headless })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
