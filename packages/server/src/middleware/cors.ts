import type { IncomingMessage, ServerResponse } from "node:http";
import { publicApiBaseUrl } from "../webview-documents.js";

type CorsScope = "public" | "restricted" | "none";

const PUBLIC_METHODS = ["GET", "HEAD", "POST", "OPTIONS"];
const RESTRICTED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const PUBLIC_HEADERS = ["content-type", "authorization"];
const RESTRICTED_HEADERS = ["content-type", "authorization", "x-admin-secret"];

export function applyRouteCors(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): void {
  const scope = corsScope(path);
  if (scope === "public") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", PUBLIC_METHODS.join(", "));
    res.setHeader("Access-Control-Allow-Headers", PUBLIC_HEADERS.map(formatHeader).join(", "));
    return;
  }

  if (scope === "restricted") {
    // Exact-origin CORS blocks cross-site fetches, but it does not prevent an
    // attacker from framing the dashboard and tricking a user into clicks.
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
  }

  if (scope === "restricted" && isExactSameOrigin(req)) {
    const origin = singleHeader(req.headers.origin)!;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", RESTRICTED_METHODS.join(", "));
    res.setHeader("Access-Control-Allow-Headers", RESTRICTED_HEADERS.map(formatHeader).join(", "));
    appendVary(res, "Origin");
  }
}

/**
 * Completes OPTIONS requests before routing. Public SDK routes retain wildcard
 * CORS. Control-plane routes only answer an exact same-origin preflight and
 * reject cross-origin or over-broad method/header requests.
 */
export function handleCorsPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): boolean {
  if ((req.method || "").toUpperCase() !== "OPTIONS") return false;

  const scope = corsScope(path);
  if (scope === "none") {
    sendPreflightError(res, 404, "Not found");
    return true;
  }

  if (scope === "restricted" && !isExactSameOrigin(req)) {
    sendPreflightError(res, 403, "Cross-origin admin requests are not allowed");
    return true;
  }

  const allowedMethods = scope === "public" ? PUBLIC_METHODS : RESTRICTED_METHODS;
  const requestedMethod = singleHeader(req.headers["access-control-request-method"])?.toUpperCase();
  if (requestedMethod && !allowedMethods.includes(requestedMethod)) {
    sendPreflightError(res, 405, "CORS method not allowed");
    return true;
  }

  const allowedHeaders = scope === "public" ? PUBLIC_HEADERS : RESTRICTED_HEADERS;
  const requestedHeaders = parseRequestedHeaders(req.headers["access-control-request-headers"]);
  if (requestedHeaders.some((header) => !allowedHeaders.includes(header))) {
    sendPreflightError(res, 400, "CORS header not allowed");
    return true;
  }

  applyRouteCors(req, res, path);
  res.writeHead(204);
  res.end();
  return true;
}

export function isExactSameOrigin(req: IncomingMessage): boolean {
  const supplied = singleHeader(req.headers.origin);
  const expected = requestOrigin(req);
  if (!supplied || !expected || supplied === "null") return false;

  try {
    // Origin is a serialized origin, not a general URL. Reject paths, trailing
    // slashes, alternate casing, and other non-canonical lookalikes.
    const parsed = new URL(supplied);
    return parsed.origin === supplied && supplied === expected;
  } catch {
    return false;
  }
}

function requestOrigin(req: IncomingMessage): string | null {
  try {
    return new URL(publicApiBaseUrl(req)).origin;
  } catch {
    return null;
  }
}

function corsScope(path: string): CorsScope {
  if (
    path === "/health" ||
    path === "/config" ||
    path === "/v1/config" ||
    path === "/events" ||
    path === "/v1/events" ||
    path.startsWith("/v1/paywall-documents/") ||
    path.startsWith("/assets/")
  ) {
    return "public";
  }

  if (
    path === "/" ||
    (path === "/config-dashboard" || path.startsWith("/config-dashboard/")) ||
    path === "/v1/usage" ||
    path.startsWith("/admin") ||
    path.startsWith("/v1/admin")
  ) {
    return "restricted";
  }

  return "none";
}

function parseRequestedHeaders(value: string | string[] | undefined): string[] {
  const raw = singleHeader(value);
  if (!raw) return [];
  return raw.split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
}

function formatHeader(header: string): string {
  return header.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("-");
}

function appendVary(res: ServerResponse, value: string): void {
  const current = res.getHeader("Vary");
  const values = (Array.isArray(current) ? current.join(",") : String(current || ""))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
  res.setHeader("Vary", values.join(", "));
}

function sendPreflightError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
