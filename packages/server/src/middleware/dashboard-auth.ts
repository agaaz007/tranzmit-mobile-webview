import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

/**
 * HTTP Basic Auth gate for the human-facing web surfaces (service root `/` and
 * `/config-dashboard`). The password lives ONLY in the `DASHBOARD_PASSWORD`
 * Railway env var — never hardcode it here, this repo is public.
 *
 * IMPORTANT: this gate is intentionally NOT applied to the SDK data plane
 * (`/v1/config`, `/v1/events`, `/v1/paywall-documents`, `/assets`, `/health`).
 * Those are called by customer apps with no credentials; gating them would take
 * every live paywall down. The `/admin` API is protected separately: the
 * `ADMIN_SECRET` and same-origin dashboard Basic auth have global access,
 * while workspace bearer secrets remain tenant-scoped.
 */
export function requireDashboardAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const expected = process.env.DASHBOARD_PASSWORD;

  // Fail closed: if the gate password is not configured, refuse rather than
  // silently serving the dashboard unprotected.
  if (!expected) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Dashboard auth not configured" }));
    return false;
  }

  const provided = parseBasicPassword(req.headers.authorization);
  if (provided !== null && secureEqual(provided, expected)) return true;

  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="Tranzmit", charset="UTF-8"',
  });
  res.end("Authentication required");
  return false;
}

function parseBasicPassword(auth: string | undefined): string | null {
  if (!auth || !auth.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : decoded;
  } catch {
    return null;
  }
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
