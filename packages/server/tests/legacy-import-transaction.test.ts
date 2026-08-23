import { beforeEach, describe, expect, it, vi } from "vitest";

const transaction = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  calls: [] as string[],
}));

vi.mock("../src/db.js", () => ({
  pool: { connect: transaction.connect },
  query: vi.fn(),
}));

function validSpec(): Record<string, unknown> {
  return {
    renderer: "webview",
    document: { html: "<main>Safe candidate</main>" },
    products: [{ id: "pro_yearly", name: "Pro", price: "₹999/year" }],
    cta: { text: "Continue" },
    dismiss: { enabled: true },
  };
}

beforeEach(() => {
  transaction.calls.length = 0;
  transaction.query.mockReset();
  transaction.release.mockReset();
  transaction.connect.mockReset();
  transaction.connect.mockResolvedValue({
    query: transaction.query,
    release: transaction.release,
  });
});

describe("legacy configuration import transaction", () => {
  it("rolls back earlier spec writes when a later placement write fails", async () => {
    transaction.query.mockImplementation(async (sql: string) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      transaction.calls.push(normalized);
      if (normalized === "BEGIN" || normalized === "ROLLBACK" || normalized === "COMMIT") {
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT id, public_key, management_status, config_source FROM clients/i.test(normalized)) {
        return {
          rows: [{
            id: "client-test",
            public_key: "pk_test",
            management_status: "editable",
            config_source: "legacy",
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO paywall_specs/i.test(normalized)) {
        return { rows: [{ id: "spec-db-id" }], rowCount: 1 };
      }
      if (/SELECT spec FROM paywall_specs/i.test(normalized)) {
        return { rows: [{ spec: validSpec() }], rowCount: 1 };
      }
      if (/INSERT INTO placements/i.test(normalized)) {
        throw new Error("simulated placement constraint failure");
      }
      return { rows: [], rowCount: 0 };
    });

    const { importLegacyWorkspaceConfig } = await import("../src/config-publish.js");
    await expect(importLegacyWorkspaceConfig("client-test", {
      specs: [{
        id: "spec-import-id",
        name: "Candidate",
        status: "active",
        spec: validSpec(),
      }],
      placements: [{
        id: "placement-import-id",
        trigger: "upgrade_pro",
        status: "active",
        default_spec_id: "spec-import-id",
      }],
      variants: [],
    })).rejects.toThrow("simulated placement constraint failure");

    expect(transaction.calls[0]).toBe("BEGIN");
    expect(transaction.calls.some((sql) => /INSERT INTO paywall_specs/i.test(sql))).toBe(true);
    expect(transaction.calls.some((sql) => /INSERT INTO placements/i.test(sql))).toBe(true);
    expect(transaction.calls.at(-1)).toBe("ROLLBACK");
    expect(transaction.calls).not.toContain("COMMIT");
    expect(transaction.release).toHaveBeenCalledTimes(1);
  });
});
