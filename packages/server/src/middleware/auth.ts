import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
import { query } from "../db.js";
import { isExactSameOrigin } from "./cors.js";

export type AdminAuthContext =
  | {
      kind: "admin";
      // resolveAdminAuth always populates this. Optionality keeps compatibility
      // with internal admin-only helpers that construct a non-request context.
      source?: "admin_secret_bearer" | "admin_secret_header" | "dashboard_basic";
    }
  | {
      kind: "workspace";
      source: "workspace_bearer";
      workspaceId: string;
      publicKey: string;
      secretKey: string;
    };

export function checkAdminAuth(req: IncomingMessage): boolean {
  return resolveStaticAdminAuth(req) !== null;
}

export async function resolveAdminAuth(req: IncomingMessage): Promise<AdminAuthContext | null> {
  const admin = resolveStaticAdminAuth(req);
  if (admin) return admin;

  // Workspace credentials are bearer-only. Basic credentials are reserved for
  // the human dashboard and x-admin-secret is reserved for ADMIN_SECRET.
  const token = parseBearerToken(req.headers.authorization);
  if (!token) return null;

  const result = await query<{ id: string; public_key: string; secret_key: string }>(
    "SELECT id, public_key, secret_key FROM clients WHERE secret_key = $1",
    [token]
  );
  const workspace = result.rows[0];
  if (!workspace || !secureEqual(token, workspace.secret_key)) return null;

  return {
    kind: "workspace",
    source: "workspace_bearer",
    workspaceId: workspace.id,
    publicKey: workspace.public_key,
    secretKey: workspace.secret_key,
  };
}

function resolveStaticAdminAuth(req: IncomingMessage): AdminAuthContext | null {
  const adminSecret = process.env.ADMIN_SECRET;
  const headerSecret = singleHeader(req.headers["x-admin-secret"]);
  if (adminSecret && headerSecret && secureEqual(headerSecret, adminSecret)) {
    return { kind: "admin", source: "admin_secret_header" };
  }

  const bearerToken = parseBearerToken(req.headers.authorization);
  if (adminSecret && bearerToken && secureEqual(bearerToken, adminSecret)) {
    return { kind: "admin", source: "admin_secret_bearer" };
  }

  const dashboardPassword = process.env.DASHBOARD_PASSWORD;
  const basicPassword = parseBasicPassword(req.headers.authorization);
  if (!dashboardPassword || basicPassword === null || !secureEqual(basicPassword, dashboardPassword)) {
    return null;
  }

  // Basic credentials are held by the browser. Require a browser-supplied,
  // exact same-origin Origin for every state-changing dashboard request to
  // prevent cross-site form/fetch mutations.
  if (isStateChanging(req.method) && !isExactSameOrigin(req)) return null;

  return { kind: "admin", source: "dashboard_basic" };
}

function parseBearerToken(auth: string | undefined): string | null {
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

function parseBasicPassword(auth: string | undefined): string | null {
  if (!auth || !/^Basic\s+/i.test(auth)) return null;
  try {
    const encoded = auth.replace(/^Basic\s+/i, "").trim();
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : decoded;
  } catch {
    return null;
  }
}

function isStateChanging(method: string | undefined): boolean {
  const normalized = (method || "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
