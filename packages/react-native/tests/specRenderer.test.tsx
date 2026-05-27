import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { composeDocumentForTest, SpecRenderer } from "../src/renderer/SpecRenderer.js";
import { baseSpec } from "./fixtures.js";

describe("SpecRenderer", () => {
  it("renders the server HTML document in a WebView", () => {
    const { getByText, getByTestId } = render(
      <SpecRenderer spec={baseSpec} presentation="inline" onCTA={() => {}} onDismiss={() => {}} />
    );

    expect(getByTestId("tranzmit-webview")).toBeTruthy();
    expect(getByText(/Unlock Pro/)).toBeTruthy();
    expect(getByText(/Start Free Trial/)).toBeTruthy();
  });

  it("maps WebView CTA bridge messages to the selected product", () => {
    const onCTA = vi.fn();
    const { getByText } = render(
      <SpecRenderer spec={baseSpec} presentation="inline" onCTA={onCTA} onDismiss={() => {}} />
    );

    fireEvent.click(getByText("Start Free Trial"));

    expect(onCTA).toHaveBeenCalledWith(expect.objectContaining({ id: "pro_monthly" }));
  });

  it("maps WebView dismiss bridge messages to dismiss", () => {
    const onDismiss = vi.fn();
    const { getByText } = render(
      <SpecRenderer spec={baseSpec} presentation="inline" onCTA={() => {}} onDismiss={onDismiss} />
    );

    fireEvent.click(getByText("Maybe later"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("injects presentation-aware fullscreen document styles", () => {
    const html = composeDocumentForTest(baseSpec, "fullscreen", {
      width: 412,
      height: 915,
      safeTop: 24,
      safeBottom: 18,
      safeLeft: 0,
      safeRight: 0,
      pixelRatio: 2.75,
      scale: 1.06,
      presentation: "fullscreen",
    });

    expect(html).toContain("tz-presentation-fullscreen");
    expect(html).toContain('data-tranzmit-presentation="fullscreen"');
    expect(html).toContain("--tz-vh: 915.00px");
    expect(html).toContain("--tz-safe-bottom: 18.00px");
    expect(html).toContain("--tz-cta-reserved-height: clamp(86px, 10.5vh, 108px)");
    expect(html).toContain('"pixelRatio":2.75');
    expect(html).toContain("border-radius: 0 !important");
    expect(html).toContain("height: var(--tz-vh) !important");
    expect(html).toContain("padding-bottom: calc(var(--tz-safe-bottom) + var(--tz-cta-reserved-height)) !important");
    expect(html).toContain("width: var(--tz-vw) !important");
    expect(html).toContain(".tz-presentation-fullscreen .tz-paywall:not(.phone) .tz-close");
    expect(html).toContain("display: none !important");
    expect(html).toContain("window.TranzmitNativeViewport");
  });

  it("does not flatten imported phone artboards with fullscreen overrides", () => {
    const html = composeDocumentForTest(
      {
        ...baseSpec,
        document: {
          html: '<main class="tz-paywall phone"><div class="cta" data-tranzmit-action="cta">Continue</div></main>',
          css: ".phone{width:412px;height:920px;border-radius:54px;box-shadow:0 0 0 11px #0c0815}",
        },
      },
      "fullscreen",
    );

    expect(html).toContain(".tz-presentation-fullscreen .tz-paywall:not(.phone)");
    expect(html).not.toContain(".tz-presentation-fullscreen .tz-paywall,\n  .tz-presentation-fullscreen .tranzmit-paywall");
    expect(html).toContain(".phone{width:412px;height:920px;border-radius:54px;box-shadow:0 0 0 11px #0c0815}");
  });
});
