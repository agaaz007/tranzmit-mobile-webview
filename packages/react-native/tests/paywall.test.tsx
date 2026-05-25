import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TranzmitPaywall, TranzmitProvider } from "../src/index.js";
import { baseSpec, mockConfig } from "./fixtures.js";

describe("TranzmitPaywall", () => {
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

  it("renders when visible and hides when invisible", async () => {
    const { queryByText, rerender } = render(
      <TranzmitProvider publicKey="pk_test_demo">
        <TranzmitPaywall trigger="upgrade_pro" visible presentation="inline" />
      </TranzmitProvider>
    );

    await waitFor(() => expect(queryByText("Unlock Pro")).toBeTruthy());

    rerender(
      <TranzmitProvider publicKey="pk_test_demo">
        <TranzmitPaywall trigger="upgrade_pro" visible={false} presentation="inline" />
      </TranzmitProvider>
    );

    expect(queryByText("Unlock Pro")).toBeNull();
  });

  it("invokes declarative CTA and dismiss callbacks", async () => {
    const onCTA = vi.fn();
    const onDismiss = vi.fn();
    const { getByText } = render(
      <TranzmitProvider publicKey="pk_test_demo">
        <TranzmitPaywall
          trigger="upgrade_pro"
          visible
          presentation="inline"
          onCTA={onCTA}
          onDismiss={onDismiss}
        />
      </TranzmitProvider>
    );

    await waitFor(() => expect(getByText("Unlock Pro")).toBeTruthy());
    fireEvent.click(getByText("Start Free Trial").closest("button")!);
    fireEvent.click(getByText("Maybe later").closest("button")!);

    expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro_monthly" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders a dynamically passed spec without a configured trigger", async () => {
    const onCTA = vi.fn();
    const dynamicSpec = {
      ...baseSpec,
      headline: "Dynamic Paywall",
      cta: "Choose Dynamic Plan",
      document: {
        ...baseSpec.document!,
        html: `
          <main class="paywall">
            <h1>Dynamic Paywall</h1>
            <button data-tranzmit-action="cta" data-product-id="pro_monthly">Choose Dynamic Plan</button>
          </main>
        `,
      },
    };

    const { getByText } = render(
      <TranzmitProvider publicKey="pk_test_demo">
        <TranzmitPaywall
          spec={dynamicSpec}
          variantId="preview"
          visible
          presentation="inline"
          onCTA={onCTA}
        />
      </TranzmitProvider>
    );

    expect(getByText("Dynamic Paywall")).toBeTruthy();
    fireEvent.click(getByText("Choose Dynamic Plan").closest("button")!);
    expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro_monthly" }));
  });
});
