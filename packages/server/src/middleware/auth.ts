import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
import { query } from "../db.js";

export interface AdminAuthContext {
  kind: "admin" | "workspace";
  workspaceId?: string;
  publicKey?: string;
  secretKey?: string;
}

export function checkAdminAuth(req: IncomingMessage): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const headerSecret = singleHeader(req.headers["x-admin-secret"]);
  if (headerSecret && secureEqual(headerSecret, secret)) return true;

  const auth = req.headers.authorization;
  if (!auth) return false;

  let token = "";
  if (auth.startsWith("Bearer ")) {
    token = auth.slice(7);
  } else if (auth.startsWith("Basic ")) {
    token = parseBasicPassword(auth.slice(6));
  } else {
    return false;
  }

  return secureEqual(token, secret);
}

export async function resolveAdminAuth(req: IncomingMessage): Promise<AdminAuthContext | null> {
  if (checkAdminAuth(req)) return { kind: "admin" };

  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return { kind: "admin" };

  const result = await query<{ id: string; public_key: string; secret_key: string }>(
    "SELECT id, public_key, secret_key FROM clients WHERE secret_key = $1",
    [token]
  );
  const workspace = result.rows[0];
  if (!workspace || !secureEqual(token, workspace.secret_key)) return { kind: "admin" };

  return {
    kind: "workspace",
    workspaceId: workspace.id,
    publicKey: workspace.public_key,
    secretKey: workspace.secret_key,
  };
}

function parseBasicPassword(encoded: string): string {
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : decoded;
  } catch {
    return "";
  }
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
