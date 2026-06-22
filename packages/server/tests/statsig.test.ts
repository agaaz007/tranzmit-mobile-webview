import { describe, expect, it } from "vitest";
import { mapIdentityToStatsigUser } from "../src/statsig.js";

describe("mapIdentityToStatsigUser", () => {
  it("uses app userId as Statsig userID when logged in", () => {
    const user = mapIdentityToStatsigUser({
      userId: "user_123",
      identifiers: { stableID: "trz_install_abc" },
      traits: {},
      privateTraits: {},
      storageUserId: "user_123",
    });
    expect(user.userID).toBe("user_123");
    expect(user.customIDs?.stableID).toBe("trz_install_abc");
    expect(user.customIDs?.tranzmitUserID).toBe("user_123");
  });

  it("uses stableID as Statsig userID when logged out", () => {
    const user = mapIdentityToStatsigUser({
      identifiers: { stableID: "trz_install_abc" },
      traits: {},
      privateTraits: {},
      storageUserId: "trz_install_abc",
    });
    expect(user.userID).toBe("trz_install_abc");
    expect(user.customIDs?.stableID).toBe("trz_install_abc");
    expect(user.customIDs?.tranzmitUserID).toBeUndefined();
  });
});
