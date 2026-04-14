/**
 * TradingView MCP — HTTP Server
 *
 * Exposes all 78 MCP tools over Streamable HTTP transport so mobile MCP
 * clients (Claude mobile, remote AI agents, etc.) can connect without
 * needing a local stdio pipe.
 *
 * Usage:
 *   MCP_API_KEY=secret PORT=3000 node src/server-http.js
 *
 * MCP endpoint:  http://<host>:<port>/mcp
 * Health check:  http://<host>:<port>/health
 *
 * Authentication:
 *   Set MCP_API_KEY env var.  Clients must send one of:
 *     x-api-key: <key>
 *     Authorization: Bearer <key>
 *   If MCP_API_KEY is not set the server starts with NO auth (dev only).
 *
 * Remote access (pick one):
 *   - Tailscale:          install on desktop + phone, use Tailscale IP
 *   - Cloudflare Tunnel:  cloudflared tunnel --url http://localhost:3000
 *   - ngrok:              ngrok http 3000
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { registerHealthTools } from "./tools/health.js";
import { registerChartTools } from "./tools/chart.js";
import { registerPineTools } from "./tools/pine.js";
import { registerDataTools } from "./tools/data.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerDrawingTools } from "./tools/drawing.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerReplayTools } from "./tools/replay.js";
import { registerIndicatorTools } from "./tools/indicators.js";
import { registerWatchlistTools } from "./tools/watchlist.js";
import { registerUiTools } from "./tools/ui.js";
import { registerPaneTools } from "./tools/pane.js";
import { registerTabTools } from "./tools/tab.js";
import { registerMorningTools } from "./tools/morning.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const API_KEY = process.env.MCP_API_KEY;

// ---------------------------------------------------------------------------
// MCP server factory — one instance per client session
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer(
    {
      name: "tradingview",
      version: "2.0.0",
      description:
        "AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol",
    },
    {
      instructions: `TradingView MCP — 78 tools for reading and controlling a live TradingView Desktop chart.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs`,
    },
  );

  registerHealthTools(server);
  registerChartTools(server);
  registerPineTools(server);
  registerDataTools(server);
  registerCaptureTools(server);
  registerDrawingTools(server);
  registerAlertTools(server);
  registerBatchTools(server);
  registerReplayTools(server);
  registerIndicatorTools(server);
  registerWatchlistTools(server);
  registerUiTools(server);
  registerPaneTools(server);
  registerTabTools(server);
  registerMorningTools(server);

  return server;
}

// ---------------------------------------------------------------------------
// Session store:  mcp-session-id header → transport instance
// ---------------------------------------------------------------------------

const sessions = new Map();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, mcp-session-id, x-api-key, authorization",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

function isAuthorized(req) {
  if (!API_KEY) return true; // no auth configured
  const fromHeader = req.headers["x-api-key"];
  const fromBearer = (req.headers["authorization"] || "").replace(
    /^Bearer\s+/i,
    "",
  );
  return fromHeader === API_KEY || fromBearer === API_KEY;
}

// ---------------------------------------------------------------------------
// Main HTTP request handler
// ---------------------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  setCors(res);

  // Pre-flight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check — no auth required
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        transport: "streamable-http",
        version: "2.0.0",
        sessions: sessions.size,
      }),
    );
    return;
  }

  // Auth check
  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Unauthorized",
        hint: "Pass your MCP_API_KEY via x-api-key header or Authorization: Bearer <key>",
      }),
    );
    return;
  }

  // Only /mcp is handled beyond this point
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", mcp_endpoint: "/mcp" }));
    return;
  }

  try {
    const sessionId =
      typeof req.headers["mcp-session-id"] === "string"
        ? req.headers["mcp-session-id"]
        : undefined;

    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      // New session — create a fresh transport + server pair
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
    }

    const body = req.method === "POST" ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

process.stderr.write(
  "⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n",
);
process.stderr.write(
  "   Ensure your usage complies with TradingView's Terms of Use.\n\n",
);

httpServer.listen(PORT, "0.0.0.0", () => {
  process.stderr.write(`TradingView MCP HTTP server started\n`);
  process.stderr.write(`  MCP endpoint : http://0.0.0.0:${PORT}/mcp\n`);
  process.stderr.write(`  Health check : http://0.0.0.0:${PORT}/health\n`);
  if (API_KEY) {
    process.stderr.write(`  Auth         : enabled (x-api-key / Bearer)\n`);
  } else {
    process.stderr.write(
      `  Auth         : DISABLED — set MCP_API_KEY env var before exposing publicly\n`,
    );
  }
  process.stderr.write("\n");
});
