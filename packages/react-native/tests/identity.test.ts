import { describe, expect, it } from "vitest";
import { resolveIdentity } from "@tranzmit/shared";

function storage() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) || null,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("identity", () => {
  it("generates and persists stable IDs per public key", async () => {
    const backing = storage();
    const first = await resolveIdentity("pk_test_one", {}, backing);
    const second = await resolveIdentity("pk_test_one", {}, backing);
    const third = await resolveIdentity("pk_test_two", {}, backing);

    expect(first.identifiers?.stableID).toMatch(/^trz_/);
    expect(second.identifiers?.stableID).toBe(first.identifiers?.stableID);
    expect(third.identifiers?.stableID).not.toBe(first.identifiers?.stableID);
  });

  it("preserves caller identifiers and user ID", async () => {
    const identity = await resolveIdentity(
      "pk_test_one",
      { userId: " user_1 ", identifiers: { accountID: "acct_1" } },
      storage()
    );

    expect(identity.userId).toBe("user_1");
    expect(identity.identifiers?.accountID).toBe("acct_1");
    expect(identity.identifiers?.stableID).toMatch(/^trz_/);
  });
});
