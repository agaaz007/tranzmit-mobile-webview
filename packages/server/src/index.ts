import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleConfig } from "./routes/config.js";
import { handleEvents } from "./routes/events.js";
import { handleAdmin } from "./routes/admin.js";
import { serveConfigDashboard } from "./routes/config-dashboard.js";
import { initStatsig, isConfigured as isStatsigConfigured, isInitialized as isStatsigInitialized, shutdownStatsig } from "./statsig.js";
import { checkRateLimit, LIMITS } from "./middleware/rate-limit.js";
import { handleUsage } from "./routes/usage.js";
import { handlePaywallDocument } from "./routes/paywall-documents.js";
import { handleAsset } from "./routes/assets.js";
import { pool } from "./db.js";
import { runMigrations } from "./migrations.js";

const PORT = parseInt(process.env.PORT || "3000", 10);

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function rateLimited(res: ServerResponse, resetAt: number): void {
  res.writeHead(429, {
    "Content-Type": "application/json",
    "Retry-After": String(Math.ceil((resetAt - Date.now()) / 1000)),
  });
  res.end(JSON.stringify({ error: "Too many requests" }));
}

function serveHome(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tranzmit WebView Paywalls</title>
  <style>
    :root{color-scheme:light;--bg:#fbfaff;--card:#fff;--ink:#17172e;--muted:#6f6878;--accent:#6537d9;--line:#e8e1f6}
    *{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,var(--bg),#fff);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:920px;margin:0 auto;padding:56px 22px}.eyebrow{color:var(--accent);font-size:13px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
    h1{font-size:clamp(34px,6vw,64px);line-height:.98;letter-spacing:-.06em;margin:10px 0 14px}p{color:var(--muted);font-size:18px;line-height:1.55;margin:0}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-top:30px}.card{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:20px;box-shadow:0 16px 40px rgba(101,55,217,.08)}
    .card b{display:block;font-size:16px;margin-bottom:6px}.card span{color:var(--muted);font-size:14px;line-height:1.45}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
    a{color:inherit}.button{background:var(--accent);border-radius:999px;color:#fff;display:inline-flex;font-weight:900;padding:13px 18px;text-decoration:none}.button.secondary{background:#f2edff;color:var(--accent)}
    code{background:#f6f2ff;border:1px solid var(--line);border-radius:10px;color:#3b246f;display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;margin-top:20px;overflow:auto;padding:14px;white-space:pre}
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Tranzmit Mobile WebView API</div>
    <h1>Server-driven paywalls are online.</h1>
    <p>This Railway service powers WebView paywall config, hosted paywall documents, analytics events, and the customer config dashboard.</p>
    <div class="actions">
      <a class="button" href="/config-dashboard">Open Config Dashboard</a>
      <a class="button secondary" href="/health">Check Health</a>
      <a class="button secondary" href="https://github.com/agaaz007/tranzmit-mobile-webview">GitHub Repo</a>
    </div>
    <div class="grid">
      <section class="card"><b>Remote paywall config</b><span>POST <code style="display:inline;margin:0;padding:2px 6px">/v1/config</code> to fetch placements, variants, and hosted WebView document URLs.</span></section>
      <section class="card"><b>Hosted WebView documents</b><span>SDKs hydrate <code style="display:inline;margin:0;padding:2px 6px">/v1/paywall-documents/...</code> payloads and cache them for offline rendering.</span></section>
      <section class="card"><b>Purchase flow</b><span>Tranzmit owns paywall UI. Customer apps own StoreKit, Play Billing, RevenueCat, or Stripe, then call <code style="display:inline;margin:0;padding:2px 6px">reportConversion()</code>.</span></section>
    </div>
    <code>curl -X POST /v1/config \\
  -H 'Content-Type: application/json' \\
  -d '{"publicKey":"pk_test_2a8a5f07d4b9fcf1cc77e024","identity":{"userId":"user_123"}}'</code>
  </main>
</body>
</html>`);
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const ip = getClientIp(req);

  try {
    // --- Human-friendly service root ---
    if (path === "/" && req.method === "GET") {
      serveHome(res);
      return;
    }

    // --- Mobile config dashboard (no rate limit, served directly) ---
    if (path === "/config-dashboard") {
      serveConfigDashboard(res);
      return;
    }

    // --- Admin routes ---
    if (path.startsWith("/admin") || path.startsWith("/v1/admin")) {
      const adminPath = path.replace(/^\/v1/, "");
      const rl = checkRateLimit(`admin:${ip}`, LIMITS.admin);
      if (!rl.allowed) { rateLimited(res, rl.resetAt); return; }
      await handleAdmin(req, res, adminPath);
      return;
    }

    // --- Config endpoint (versioned + legacy) ---
    if ((path === "/v1/config" || path === "/config") && (req.method === "GET" || req.method === "POST")) {
      const key = req.method === "POST" ? ip : (url.searchParams.get("key") || "unknown");
      const rl = checkRateLimit(`config:${key}`, LIMITS.config);
      if (!rl.allowed) { rateLimited(res, rl.resetAt); return; }
      await handleConfig(req, res);
      return;
    }

    // --- Hosted WebView document payloads ---
    if (path.startsWith("/v1/paywall-documents/")) {
      const key = url.searchParams.get("key") || "unknown";
      const rl = checkRateLimit(`paywall-doc:${key}`, LIMITS.config);
      if (!rl.allowed) { rateLimited(res, rl.resetAt); return; }
      await handlePaywallDocument(req, res, path);
      return;
    }

    // --- Immutable paywall image assets ---
    if (path.startsWith("/assets/") && req.method === "GET") {
      await handleAsset(res, path);
      return;
    }

    // --- Events endpoint (versioned + legacy) ---
    if ((path === "/v1/events" || path === "/events") && req.method === "POST") {
      const rl = checkRateLimit(`events:${ip}`, LIMITS.events);
      if (!rl.allowed) { rateLimited(res, rl.resetAt); return; }
      await handleEvents(req, res);
      return;
    }

    // --- Health check (with DB probe) ---
    if (path === "/health") {
      let dbOk = false;
      try {
        await pool.query("SELECT 1");
        dbOk = true;
      } catch { /* db down */ }

      const status = dbOk ? "ok" : "degraded";
      const code = dbOk ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status,
        db: dbOk ? "connected" : "unreachable",
        dbConnected: dbOk,
        statsigConfigured: isStatsigConfigured(),
        statsigInitialized: isStatsigInitialized(),
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // --- Usage/billing endpoint ---
    if ((path === "/v1/usage" || path === "/admin/usage") && req.method === "GET") {
      const rl = checkRateLimit(`admin:${ip}`, LIMITS.admin);
      if (!rl.allowed) { rateLimited(res, rl.resetAt); return; }
      await handleUsage(req, res);
      return;
    }

    // --- 404 ---
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err: any) {
    if (err?.name === "PayloadTooLargeError") {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large (max 512KB)" }));
      return;
    }
    console.error("[Tranzmit] Unhandled error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

async function start(): Promise<void> {
  await runMigrations();
  await initStatsig();

  const server = createServer(handler);

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(PORT, () => {
    console.log(`[Tranzmit] Server running on port ${PORT}`);
  });

  process.on("SIGTERM", () => {
    console.log("[Tranzmit] Shutting down gracefully...");
    server.close(() => {
      Promise.allSettled([shutdownStatsig(), pool.end()]).then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000);
  });
}

start().catch((err) => {
  console.error("[Tranzmit] Failed to start:", err);
  process.exit(1);
});
