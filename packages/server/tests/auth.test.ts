import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";

const originalPublicApiBaseUrl = process.env.PUBLIC_API_BASE_URL;

vi.mock("../src/db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
}));

function request(input: {
  method?: string;
  authorization?: string;
  adminHeader?: string;
  origin?: string;
  host?: string;
  forwardedProto?: string;
} = {}): IncomingMessage {
  return {
    method: input.method || "GET",
    headers: {
      authorization: input.authorization,
      "x-admin-secret": input.adminHeader,
      origin: input.origin,
      host: input.host || "dashboard.example.com",
      "x-forwarded-proto": input.forwardedProto || "https",
    },
    socket: {},
  } as IncomingMessage;
}

function basic(password: string): string {
  return `Basic ${Buffer.from(`dashboard:${password}`).toString("base64")}`;
}

describe("admin authentication", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.PUBLIC_API_BASE_URL;
    process.env.ADMIN_SECRET = "admin-secret";
    process.env.DASHBOARD_PASSWORD = "dashboard-password";
    const db = await import("../src/db.js");
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
  });

  afterEach(() => {
    if (originalPublicApiBaseUrl === undefined) {
      delete process.env.PUBLIC_API_BASE_URL;
    } else {
      process.env.PUBLIC_API_BASE_URL = originalPublicApiBaseUrl;
    }
  });

  it("fails closed for missing and invalid credentials", async () => {
    const { resolveAdminAuth } = await import("../src/middleware/auth.js");
    expect(await resolveAdminAuth(request())).toBeNull();
    expect(await resolveAdminAuth(request({ authorization: "Bearer wrong" }))).toBeNull();
    expect(await resolveAdminAuth(request({ adminHeader: "wrong" }))).toBeNull();
  });

  it("accepts ADMIN_SECRET only from bearer or x-admin-secret and records the source", async () => {
    const { resolveAdminAuth } = await import("../src/middleware/auth.js");
    await expect(resolveAdminAuth(request({ authorization: "Bearer admin-secret" }))).resolves.toEqual({
      kind: "admin",
      source: "admin_secret_bearer",
    });
    await expect(resolveAdminAuth(request({ adminHeader: "admin-secret" }))).resolves.toEqual({
      kind: "admin",
      source: "admin_secret_header",
    });
    await expect(resolveAdminAuth(request({ authorization: basic("admin-secret") }))).resolves.toBeNull();
  });

  it("accepts DASHBOARD_PASSWORD via Basic for reads", async () => {
    const { resolveAdminAuth } = await import("../src/middleware/auth.js");
    await expect(resolveAdminAuth(request({ authorization: basic("dashboard-password") }))).resolves.toEqual({
      kind: "admin",
      source: "dashboard_basic",
    });
  });

  it("requires exact same-origin Origin for Basic state-changing requests", async () => {
    const { resolveAdminAuth } = await import("../src/middleware/auth.js");
    const authorization = basic("dashboard-password");

    await expect(resolveAdminAuth(request({ method: "POST", authorization }))).resolves.toBeNull();
    await expect(resolveAdminAuth(request({
      method: "POST",
      authorization,
      origin: "https://evil.example.com",
    }))).resolves.toBeNull();
    await expect(resolveAdminAuth(request({
      method: "POST",
      authorization,
      origin: "https://dashboard.example.com/",
    }))).resolves.toBeNull();
    await expect(resolveAdminAuth(request({
      method: "POST",
      authorization,
      origin: "https://dashboard.example.com",
    }))).resolves.toEqual({ kind: "admin", source: "dashboard_basic" });
  });

  it("accepts a workspace secret only as bearer and records its scope", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: "client_1", public_key: "pk_live_1", secret_key: "workspace-secret" }],
    } as never);
    const { resolveAdminAuth } = await import("../src/middleware/auth.js");

    await expect(resolveAdminAuth(request({ authorization: "Bearer workspace-secret" }))).resolves.toEqual({
      kind: "workspace",
      source: "workspace_bearer",
      workspaceId: "client_1",
      publicKey: "pk_live_1",
      secretKey: "workspace-secret",
    });
    await expect(resolveAdminAuth(request({ authorization: basic("workspace-secret") }))).resolves.toBeNull();
    await expect(resolveAdminAuth(request({ adminHeader: "workspace-secret" }))).resolves.toBeNull();
  });
});
