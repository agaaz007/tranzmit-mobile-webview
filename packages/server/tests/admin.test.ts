import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

vi.mock("../src/db.js", () => ({
  query: vi.fn(async () => ({ rows: [] })),
}));

async function makeAdminRequest(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string
): Promise<{ status: number; body: string }> {
  const { handleAdmin } = await import("../src/routes/admin.js");

  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      await handleAdmin(req, res, url.pathname);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`, { headers, method, body })
        .then(async (response) => {
          const text = await response.text();
          server.close();
          resolve({ status: response.status, body: text });
        })
        .catch((err) => {
          server.close();
          resolve({ status: 500, body: err.message });
        });
    });
  });
}

describe("GET /admin/events/recent", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    process.env.ADMIN_SECRET = "test-secret";
  });

  it("rejects admin requests without credentials", async () => {
    const res = await makeAdminRequest("/admin/events/recent");
    expect(res.status).toBe(401);
  });

  it("returns recent events with a bounded limit", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          id: "1",
          public_key: "pk_test_valid",
          user_id: "u_123",
          session_id: "sess_123",
          event_name: "impression",
          properties: { trigger: "upgrade_pro", variantId: "var_a" },
          identity: { userId: "u_123", identifiers: { stableID: "stable_123" } },
          created_at: "2026-05-20T19:00:00.000Z",
        },
      ],
    } as never);

    const res = await makeAdminRequest("/admin/events/recent?limit=1", {
      Authorization: "Bearer test-secret",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      expect.objectContaining({
        event_name: "impression",
        public_key: "pk_test_valid",
      }),
    ]);
    expect(vi.mocked(db.query)).toHaveBeenCalledWith(
      expect.stringContaining("FROM events"),
      [1]
    );
  });
});

describe("client Statsig project metadata", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ADMIN_SECRET = "test-secret";
    process.env.STATSIG_SERVER_SECRET_ACME = "statsig-super-private-value";
    delete process.env.STATSIG_SERVER_SECRET_MISSING;
  });

  it("returns client Statsig env var status without exposing the secret", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          id: "client_1",
          public_key: "pk_test_valid",
          name: "Acme",
          sdk_stack: "flutter",
          statsig_project_name: "Acme production",
          statsig_server_secret_env_var: "STATSIG_SERVER_SECRET_ACME",
          created_at: "2026-05-20T19:00:00.000Z",
        },
      ],
    } as never);

    const res = await makeAdminRequest("/admin/clients", {
      Authorization: "Bearer test-secret",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([
      expect.objectContaining({
        statsig_project_name: "Acme production",
        statsig_server_secret_env_var: "STATSIG_SERVER_SECRET_ACME",
        sdk_stack: "flutter",
        statsig_configured: true,
      }),
    ]);
    expect(res.body).not.toContain("statsig-super-private-value");
  });

  it("rejects invalid Statsig env var names on client update", async () => {
    const res = await makeAdminRequest(
      "/admin/clients/client_1",
      { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      "PATCH",
      JSON.stringify({ statsigServerSecretEnvVar: "not-valid" })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Invalid Statsig server secret env var",
    });
  });

  it("creates clients with a normalized SDK stack", async () => {
    const db = await import("../src/db.js");

    const res = await makeAdminRequest(
      "/admin/clients",
      { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      "POST",
      JSON.stringify({ name: "Acme Flutter", sdkStack: "flutter" })
    );

    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual(expect.objectContaining({
      name: "Acme Flutter",
      sdk_stack: "flutter",
      setup: expect.objectContaining({
        sdkStack: "flutter",
        sdkInstallTitle: "Drop into the Flutter app",
      }),
    }));
    expect(vi.mocked(db.query)).toHaveBeenCalledWith(
      expect.stringContaining("sdk_stack"),
      expect.arrayContaining(["flutter"])
    );
  });

  it("rejects invalid SDK stack values on client update", async () => {
    const res = await makeAdminRequest(
      "/admin/clients/client_1",
      { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      "PATCH",
      JSON.stringify({ sdkStack: "cordova" })
    );

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Invalid SDK stack",
    });
  });
});

describe("PATCH /admin/placements/:id", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ADMIN_SECRET = "test-secret";
  });

  it("returns 404 instead of inserting variants for a stale placement id", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const res = await makeAdminRequest(
      "/admin/placements/pl_missing",
      { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      "PATCH",
      JSON.stringify({
        experimentId: "transmit_waveall",
        variants: [{ variantId: "test", enabled: true, fallbackRank: 1, spec: { headline: "Test" } }],
      })
    );

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: "Placement not found. Refresh the dashboard and try again.",
    });
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(1);
  });
});

describe("workspace admin isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ADMIN_SECRET = "test-secret";
  });

  it("scopes placement listings to the authenticated workspace", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: "client_1", public_key: "pk_live_1", secret_key: "workspace-secret" }],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const res = await makeAdminRequest("/admin/placements", {
      Authorization: "Bearer workspace-secret",
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(db.query)).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE c.id = $1"),
      ["client_1"]
    );
  });

  it("prevents workspace credentials from creating clients", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: "client_1", public_key: "pk_live_1", secret_key: "workspace-secret" }],
    } as never);

    const res = await makeAdminRequest(
      "/admin/clients",
      { Authorization: "Bearer workspace-secret", "Content-Type": "application/json" },
      "POST",
      JSON.stringify({ name: "Other tenant" })
    );

    expect(res.status).toBe(403);
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(1);
  });

  it("scopes recent events to the authenticated public key", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: "client_1", public_key: "pk_live_1", secret_key: "workspace-secret" }],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const res = await makeAdminRequest("/admin/events/recent?limit=1", {
      Authorization: "Bearer workspace-secret",
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(db.query)).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE public_key = $1"),
      ["pk_live_1", 1]
    );
  });

  it("ignores a different client query when workspace credentials request usage", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: "client_1", public_key: "pk_live_1", secret_key: "workspace-secret" }],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const res = await makeAdminRequest(
      "/admin/usage?client=pk_live_other&period=7d",
      { Authorization: "Bearer workspace-secret" }
    );

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expect.objectContaining({
      client: "pk_live_1",
      period: "7d",
    }));
    expect(vi.mocked(db.query)).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("WHERE public_key = $1"),
      ["pk_live_1", expect.any(String)]
    );
    expect(vi.mocked(db.query)).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("WHERE public_key = $1"),
      ["pk_live_1", expect.any(String)]
    );
  });

  it("prevents workspace credentials from deleting a client", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ id: "client_1", public_key: "pk_live_1", secret_key: "workspace-secret" }],
    } as never);

    const res = await makeAdminRequest(
      "/admin/clients/client_1",
      { Authorization: "Bearer workspace-secret" },
      "DELETE"
    );

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "Admin credential required" });
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(1);
  });

  it("prevents workspace credentials from deleting another workspace's placement", async () => {
    const db = await import("../src/db.js");
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ id: "client_1", public_key: "pk_live_1", secret_key: "workspace-secret" }],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const res = await makeAdminRequest(
      "/admin/placements/pl_other",
      { Authorization: "Bearer workspace-secret" },
      "DELETE"
    );

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Placement not found" });
    expect(vi.mocked(db.query)).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("c.id = $2"),
      ["pl_other", "client_1"]
    );
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(db.query).mock.calls).not.toEqual(
      expect.arrayContaining([[expect.stringContaining("DELETE FROM placements"), expect.anything()]])
    );
  });
});
