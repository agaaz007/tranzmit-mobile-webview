import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { delegatedActor } from "../src/routes/admin-v2.js";

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

describe("delegatedActor", () => {
  it("keeps the credential source when no delegation headers are sent", () => {
    expect(delegatedActor(req({}), "admin_secret_bearer")).toBe("admin_secret_bearer");
  });

  it("folds the approving person and launch package into the audited actor", () => {
    const actor = delegatedActor(req({
      "x-tranzmit-actor": encode({ id: "member-42", label: "Priya Shah", kind: "member", role: "approver" }),
      "x-tranzmit-launch-package": "3f1c9a2e-0b7d-4c1e-9f00-1a2b3c4d5e6f@3#9c1d2e",
    }), "admin_secret_bearer");
    expect(actor).toBe("admin_secret_bearer for member:member-42 (Priya Shah) role=approver launch_package=3f1c9a2e-0b7d-4c1e-9f00-1a2b3c4d5e6f@3#9c1d2e");
  });

  it("rejects malformed or unsafe actor headers instead of auditing garbage", () => {
    expect(() => delegatedActor(req({ "x-tranzmit-actor": "not-base64-json" }), "admin")).toThrow(/X-Tranzmit-Actor/);
    expect(() => delegatedActor(req({ "x-tranzmit-actor": encode({ id: "x", label: "a\nb", kind: "member" }) }), "admin")).toThrow(/X-Tranzmit-Actor/);
    expect(() => delegatedActor(req({ "x-tranzmit-actor": encode({ id: "x", kind: "member" }) }), "admin")).toThrow(/X-Tranzmit-Actor/);
    expect(() => delegatedActor(req({ "x-tranzmit-launch-package": "a b;drop" }), "admin")).toThrow(/Launch-Package/);
  });
});
