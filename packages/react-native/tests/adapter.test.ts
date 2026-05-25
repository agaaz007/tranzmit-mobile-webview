import { beforeEach, describe, expect, it, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState } from "react-native";
import { reactNativeAdapter } from "../src/adapter.js";

describe("reactNativeAdapter", () => {
  beforeEach(() => {
    (AsyncStorage as any).clear();
    (AppState as any).__reset();
  });

  it("reads, writes, and removes AsyncStorage values", async () => {
    await reactNativeAdapter.storage.set("tranzmit:test", "value");
    expect(await reactNativeAdapter.storage.get("tranzmit:test")).toBe("value");
    await reactNativeAdapter.storage.remove("tranzmit:test");
    expect(await reactNativeAdapter.storage.get("tranzmit:test")).toBeNull();
  });

  it("fires background and foreground lifecycle callbacks", () => {
    const onBackground = vi.fn();
    const onForeground = vi.fn();

    const offBackground = reactNativeAdapter.lifecycle.onBackground(onBackground);
    const offForeground = reactNativeAdapter.lifecycle.onForeground(onForeground);

    (AppState as any).__emit("inactive");
    expect(onBackground).toHaveBeenCalledTimes(1);

    (AppState as any).__emit("active");
    expect(onForeground).toHaveBeenCalledTimes(1);

    offBackground();
    offForeground();
  });
});
