import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TranzmitProvider, useTranzmit } from "../src/index.js";
import { baseSpec, mockConfig } from "./fixtures.js";

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

function ImmediateFallbackHarness({ onFallback }: { onFallback?: any }) {
  const { gate } = useTranzmit();

  useEffect(() => {
    gate("upgrade_pro", { onFallback });
  }, [gate, onFallback]);

  return null;
}

function MissingPlacementHarness({ onFallback }: { onFallback?: any }) {
  const { isReady, gate } = useTranzmit();

  useEffect(() => {
    if (isReady) {
      gate("missing_trigger", { onFallback });
    }
  }, [gate, isReady, onFallback]);

  return null;
}

function SetTraitsGateHarness({ onGate }: { onGate?: any }) {
  const { isReady, setTraits, gate } = useTranzmit();
  const [didRoute, setDidRoute] = useState(false);

  useEffect(() => {
    if (!isReady || didRoute) return;
    setDidRoute(true);
    void (async () => {
      await setTraits({ intent: "wealth" });
      onGate?.(gate("upgrade_pro", { presentation: "modal" }));
    })();
  }, [didRoute, gate, isReady, onGate, setTraits]);

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

  it("calls fallback when gate is requested before Tranzmit is ready", async () => {
    const onFallback = vi.fn();
    render(
      <TranzmitProvider publicKey="pk_test_demo">
        <ImmediateFallbackHarness onFallback={onFallback} />
      </TranzmitProvider>
    );

    await waitFor(() => expect(onFallback).toHaveBeenCalledWith({
      trigger: "upgrade_pro",
      reason: "not_ready",
    }));
  });

  it("calls fallback when a placement is missing", async () => {
    const onFallback = vi.fn();
    render(
      <TranzmitProvider publicKey="pk_test_demo">
        <MissingPlacementHarness onFallback={onFallback} />
      </TranzmitProvider>
    );

    await waitFor(() => expect(onFallback).toHaveBeenCalledWith({
      trigger: "missing_trigger",
      reason: "placement_not_found",
    }));
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

  it("merges runtime traits, refetches config, and gates the routed placement", async () => {
    const routedConfig = {
      ...mockConfig,
      placements: {
        upgrade_pro: {
          ...mockConfig.placements.upgrade_pro,
          variantId: "wealth_arm",
          variant_key: "wealth_arm",
          spec: {
            ...baseSpec,
            header: {
              ...baseSpec.header,
              title: "Hindi Wealth",
            },
            document: {
              ...baseSpec.document,
              html: `
                <main class="paywall">
                  <h1>Hindi Wealth</h1>
                  <button data-tranzmit-action="cta" data-product-id="pro_monthly">Start Wealth Trial</button>
                </main>
              `,
            },
          },
        },
      },
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return {
        ok: true,
        json: () => Promise.resolve(body.traits?.intent === "wealth" ? routedConfig : mockConfig),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const onGate = vi.fn();
    const { getByText } = render(
      <TranzmitProvider publicKey="pk_test_demo" userTraits={{ plan: "free" }}>
        <SetTraitsGateHarness onGate={onGate} />
      </TranzmitProvider>
    );

    await waitFor(() => expect(getByText("Hindi Wealth")).toBeTruthy());
    await waitFor(() => expect(onGate).toHaveBeenCalledWith(expect.objectContaining({
      shown: true,
      variantId: "wealth_arm",
    })));

    const configBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/v1/config"))
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(configBodies[0].traits).toEqual({ plan: "free" });
    expect(configBodies[configBodies.length - 1].traits).toMatchObject({
      plan: "free",
      intent: "wealth",
    });
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

  it("calls fallback when the WebView renderer fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          ...mockConfig,
          placements: {
            upgrade_pro: {
              ...mockConfig.placements.upgrade_pro,
              spec: {
                ...mockConfig.placements.upgrade_pro.spec,
                document: {
                  html: "<main data-trigger-webview-error><h1>Broken Paywall</h1></main>",
                },
              },
            },
          },
        }),
      })
    );
    const onFallback = vi.fn();
    render(
      <TranzmitProvider publicKey="pk_test_demo">
        <RenderErrorHarness onFallback={onFallback} />
      </TranzmitProvider>
    );

    await waitFor(() => expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "upgrade_pro",
      reason: "render_error",
      error: expect.any(Error),
      variantId: "var_a",
    })));
  });
});

function RenderErrorHarness({ onFallback }: { onFallback?: any }) {
  const { isReady, gate } = useTranzmit();

  useEffect(() => {
    if (isReady) {
      gate("upgrade_pro", { onFallback });
    }
  }, [gate, isReady, onFallback]);

  return null;
}
