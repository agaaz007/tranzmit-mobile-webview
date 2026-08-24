import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_PROBE_WIDTHS } from "../src/paywall-preflight.js";

/**
 * The dashboard measures device renders with a copy of the SDK repo's
 * `templates/preview` harness, vendored by scripts/vendor-preview-harness.mjs.
 * If that copy drifts, the dashboard and the authoring harness stop enforcing
 * the same definition of "renders correctly" — and the dashboard is the one
 * that gates publishing, so the drift would only surface on real devices.
 */
const dashboard = resolve(process.cwd(), "packages/server/public/config-dashboard");

function read(file: string): string {
  return readFileSync(resolve(dashboard, file), "utf8");
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(resolve(dashboard, file))).digest("hex");
}

const manifest = JSON.parse(read("preview-harness.json"));

describe("vendored preview harness", () => {
  it("records the SDK it was built from", () => {
    expect(manifest.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.generatedBy).toBe("scripts/vendor-preview-harness.mjs");
  });

  it("has not drifted from the recorded hashes", () => {
    for (const [file, hash] of Object.entries(manifest.files as Record<string, string>)) {
      expect(sha256(file), `${file} changed without re-running the vendoring script`).toBe(hash);
    }
  });

  it("keeps the audit contract the dashboard depends on", () => {
    const harness = read("responsive.mjs");
    expect(harness).toContain("export const RESPONSIVE_DEVICES");
    expect(harness).toContain("export function injectResponsiveAudit");
    expect(harness).toContain('type: "tranzmit-responsive-audit"');
    // The audit must post a verdict plus reasons; the server stores both.
    expect(harness).toContain("passed: failures.length === 0");
  });

  it("gates on widths the vendored device matrix actually renders", () => {
    const harness = read("responsive.mjs");
    const matrix = harness.slice(
      harness.indexOf("export const RESPONSIVE_DEVICES = ["),
      harness.indexOf("];", harness.indexOf("export const RESPONSIVE_DEVICES = ["))
    );
    const widths = Array.from(matrix.matchAll(/\bwidth:\s*(\d+)\b/g)).map((match) => Number(match[1]));
    expect(widths.length).toBeGreaterThan(0);
    for (const required of REQUIRED_PROBE_WIDTHS) {
      expect(widths, `no device renders at ${required}px`).toContain(required);
    }
    // Every phone width in the matrix is gated; only the tablet is advisory.
    const phones = widths.filter((width) => width <= 430);
    expect([...new Set(phones)].sort((a, b) => a - b)).toEqual([...REQUIRED_PROBE_WIDTHS].sort((a, b) => a - b));
  });

  it("bundles the SDK composer, not a raw-document renderer", () => {
    const bundle = read("compose.bundle.js");
    expect(bundle).toContain("renderDocument");
    expect(bundle).toContain("resolveTheme");
    expect(bundle).toContain("SDK_VERSION");
    // A composer that pulled in react-native would not run in the dashboard.
    expect(bundle).not.toContain('require("react-native")');
    expect(bundle).not.toContain('from "react-native"');
  });

  it("is reachable from the dashboard's asset allowlist", async () => {
    const { serveConfigDashboard } = await import("../src/routes/config-dashboard.js");
    for (const path of [
      "/config-dashboard/responsive.mjs",
      "/config-dashboard/compose.bundle.js",
      "/config-dashboard/preview-harness.json",
    ]) {
      const served = serveConfigDashboard(
        { writeHead: () => undefined, end: () => undefined } as never,
        path
      );
      expect(served, `${path} is not in the allowlist`).toBe(true);
    }
  });
});
