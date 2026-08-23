import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";

const repoRelativeDashboard = resolve(process.cwd(), "packages/server/public/config-dashboard");
const workspaceRelativeDashboard = resolve(process.cwd(), "public/config-dashboard");
const DASHBOARD_DIR = existsSync(repoRelativeDashboard)
  ? repoRelativeDashboard
  : workspaceRelativeDashboard;

const ASSETS: Record<string, { file: string; type: string; cache: string }> = {
  "/config-dashboard": {
    file: "index.html",
    type: "text/html; charset=utf-8",
    cache: "no-store",
  },
  "/config-dashboard/": {
    file: "index.html",
    type: "text/html; charset=utf-8",
    cache: "no-store",
  },
  "/config-dashboard/index.html": {
    file: "index.html",
    type: "text/html; charset=utf-8",
    cache: "no-store",
  },
  "/config-dashboard/styles.css": {
    file: "styles.css",
    type: "text/css; charset=utf-8",
    cache: "no-cache",
  },
  "/config-dashboard/app.js": {
    file: "app.js",
    type: "text/javascript; charset=utf-8",
    cache: "no-cache",
  },
};

/**
 * Serves the dependency-free V2 publishing dashboard from a fixed allowlist.
 * Keeping the assets outside this module prevents customer HTML, CSS, images,
 * and font blobs from becoming part of the control-plane server bundle.
 */
export function serveConfigDashboard(
  res: ServerResponse,
  path = "/config-dashboard"
): boolean {
  const asset = ASSETS[path];
  if (!asset) return false;

  try {
    const body = readFileSync(`${DASHBOARD_DIR}/${asset.file}`);
    res.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": asset.cache,
      "Content-Security-Policy": [
        "default-src 'self'",
        // The sandboxed srcdoc preview must execute the exact stored inline
        // CSS/JS payload. The dashboard shell itself remains static and has no
        // server-rendered user values.
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data: https:",
        "connect-src 'self'",
        "frame-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    res.end(body);
  } catch (error) {
    console.error("[Tranzmit] Dashboard asset unavailable:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Dashboard asset unavailable" }));
  }
  return true;
}
