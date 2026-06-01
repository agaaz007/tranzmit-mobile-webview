import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TranzmitProvider, useTranzmit } from "../src/index.js";
import { mockConfig } from "./fixtures.js";

function GateHarness({ onCTA, onDismiss }: { onCTA?: any; onDismiss?: any }) {
  const { isReady, gate } = useTranzmit();

  useEffect(() => {
    if (isReady) {
      gate("upgrade_pro", {
        presentation: "modal",
        onCTA,
        onDismiss,
      });
    }
  }, [gate, isReady, onCTA, onDismiss]);

  return <div>{isReady ? "ready" : "loading"}</div>;
}

describe("TranzmitProvider", () => {
  beforeEach(() => {
    (AsyncStorage as any).clear();
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfig),
      })
    );
  });

  it("fetches config and exposes ready state", async () => {
    const { getByText } = render(
      <TranzmitProvider publicKey="pk_test_demo">
        <GateHarness />
      </TranzmitProvider>
    );

    await waitFor(() => expect(getByText("ready")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith(
      "https://tranzmit-api-production.up.railway.app/v1/config",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("renders a paywall from gate and invokes CTA callback", async () => {
    const onCTA = vi.fn();
    const { getByText } = render(
      <TranzmitProvider publicKey="pk_test_demo">
        <GateHarness onCTA={onCTA} />
      </TranzmitProvider>
    );

    await waitFor(() => expect(getByText("Unlock Pro")).toBeTruthy());
    fireEvent.click(getByText("Start Free Trial").closest("button")!);

    expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro_monthly" }));
  });

  it("tracks dismissals from the rendered paywall", async () => {
    const onDismiss = vi.fn();
    const { getByText } = render(
      <TranzmitProvider publicKey="pk_test_demo">
        <GateHarness onDismiss={onDismiss} />
      </TranzmitProvider>
    );

    await waitFor(() => expect(getByText("Unlock Pro")).toBeTruthy());
    fireEvent.click(getByText("Maybe later").closest("button")!);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("re-inits when userId changes from anonymous to logged-in", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockConfig),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender, getByText } = render(
      <TranzmitProvider publicKey="pk_test_demo">
        <GateHarness />
      </TranzmitProvider>
    );

    await waitFor(() => expect(getByText("ready")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(
      <TranzmitProvider publicKey="pk_test_demo" userId="user_123">
        <GateHarness />
      </TranzmitProvider>
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getByText("ready")).toBeTruthy());
    const configBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
    expect(configBody.identity.userId).toBe("user_123");
  });

  it("hydrates hosted WebView documents before rendering", async () => {
    const hostedConfig = {
      ...mockConfig,
      placements: {
        upgrade_pro: {
          ...mockConfig.placements.upgrade_pro,
          spec: {
            ...mockConfig.placements.upgrade_pro.spec,
            cacheKey: "hosted:test-1",
            document: {
              url: "https://example.test/v1/paywall-documents/pl_1/var_a/hosted%3Atest-1.json?key=pk_test_demo",
            },
          },
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/v1/paywall-documents/")) {
          return {
            ok: true,
            headers: { get: () => "application/json" },
            json: () => Promise.resolve({
              html: "<main><h1>Hosted Upgrade</h1><button data-tranzmit-action=\"cta\" data-product-id=\"pro_monthly\">Buy Hosted</button></main>",
              css: "body{font-family:sans-serif}",
              integrity: "sha256-test",
            }),
          };
        }
        return {
          ok: true,
          json: () => Promise.resolve(hostedConfig),
        };
      })
    );

    const onCTA = vi.fn();
    const { getByText } = render(
      <TranzmitProvider publicKey="pk_test_demo" apiBaseUrl="https://example.test">
        <GateHarness onCTA={onCTA} />
      </TranzmitProvider>
    );

    await waitFor(() => expect(getByText("Hosted Upgrade")).toBeTruthy());
    fireEvent.click(getByText("Buy Hosted").closest("button")!);
    expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro_monthly" }));
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/paywall-documents/"),
    );
  });
});
