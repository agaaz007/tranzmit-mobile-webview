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
    const html = composeDocumentForTest(baseSpec, "fullscreen");

    expect(html).toContain("tz-presentation-fullscreen");
    expect(html).toContain('data-tranzmit-presentation="fullscreen"');
    expect(html).toContain("border-radius: 0 !important");
    expect(html).toContain("width: 100vw !important");
    expect(html).toContain(".tz-presentation-fullscreen .tz-close");
    expect(html).toContain("display: none !important");
  });
});
