import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleConfig } from "./routes/config.js";
import { handleEvents } from "./routes/events.js";
import { handleAdmin } from "./routes/admin.js";
import { serveConfigDashboard } from "./routes/config-dashboard.js";
import { initStatsig, isConfigured as isStatsigConfigured, isInitialized as isStatsigInitialized, shutdownStatsig } from "./statsig.js";
import { checkRateLimit, LIMITS } from "./middleware/rate-limit.js";
import { handleUsage } from "./routes/usage.js";
import { handlePaywallDocument } from "./routes/paywall-documents.js";
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
