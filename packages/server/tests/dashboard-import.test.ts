import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The import pipeline runs in the operator's browser, so it is loaded here the
 * same way the dashboard loads it: evaluate the file, then use what it puts on
 * `window`.
 */
const source = readFileSync(
  resolve(process.cwd(), "packages/server/public/config-dashboard/import.js"),
  "utf8"
);

let TranzmitImport: any;

function fileEntry(path: string, contents: string | Uint8Array, type = "text/html"): { path: string; file: File } {
  const parts: BlobPart[] = [typeof contents === "string" ? contents : contents.slice().buffer as ArrayBuffer];
  return { path, file: new File(parts, path.split("/").pop() || path, { type }) };
}

beforeAll(() => {
  new Function(source).call(globalThis);
  TranzmitImport = (globalThis as any).window.TranzmitImport;
});

const PAYWALL_HTML = [
  "<!doctype html><html><head><style>.hero{background:url('assets/bg.png')}</style></head><body>",
  '<div class="device"><div class="screen"><img src="assets/hero.png" alt="">',
  '<button class="cta">Continue</button></div></div>',
  "</body></html>",
].join("");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("dashboard paywall import", () => {
  it("inlines every referenced asset and reports the ones that are missing", async () => {
    const built = await TranzmitImport.buildBundle([
      fileEntry("index.html", PAYWALL_HTML),
      fileEntry("assets/hero.png", PNG, "image/png"),
    ]);

    expect(built.entryPath).toBe("index.html");
    expect(built.html).not.toContain("assets/hero.png");
    expect(built.html).toContain("data:image/png;base64,");
    expect(built.assets.map((asset: any) => asset.path)).toEqual(["assets/hero.png"]);
    expect(built.missingAssets).toEqual(["assets/bg.png"]);
  });

  it("wires the CTA bridge onto an export that forgot it", async () => {
    const built = await TranzmitImport.buildBundle([fileEntry("index.html", PAYWALL_HTML)]);
    expect(built.bakedBridge).toBe(true);
    expect(built.html).toContain('data-tranzmit-action="cta"');
  });

  it("leaves an already wired CTA alone", async () => {
    const html = PAYWALL_HTML.replace('class="cta"', 'class="cta" data-tranzmit-action="cta"');
    const built = await TranzmitImport.buildBundle([fileEntry("index.html", html)]);
    expect(built.bakedBridge).toBe(false);
    expect(built.html.match(/data-tranzmit-action="cta"/g)).toHaveLength(1);
  });

  it("bakes the flatten layer for legacy skeletons and not for tz-template documents", async () => {
    expect(TranzmitImport.looksLegacy(PAYWALL_HTML)).toBe(true);
    expect(TranzmitImport.looksLegacy('<main class="tz-template"><div class="tz-scroll"></div></main>')).toBe(false);

    const legacy = await TranzmitImport.buildBundle([fileEntry("index.html", PAYWALL_HTML)], { flatten: true });
    expect(legacy.bakedFlatten).toBe(true);
    expect(legacy.html).toContain("Tranzmit full-bleed flatten (baked");

    const modern = await TranzmitImport.buildBundle([fileEntry("index.html", PAYWALL_HTML)], { flatten: false });
    expect(modern.bakedFlatten).toBe(false);
    expect(modern.html).not.toContain("Tranzmit full-bleed flatten (baked");
  });

  it("computes an integrity hash over the final bytes", async () => {
    const built = await TranzmitImport.buildBundle([fileEntry("index.html", PAYWALL_HTML)]);
    const { createHash } = await import("node:crypto");
    const expected = "sha256-" + createHash("sha256").update(built.html, "utf8").digest("base64");
    expect(built.integrity).toBe(expected);
  });

  it("reads localization from the bundle, accepting a bare locale map", async () => {
    const withBlock = await TranzmitImport.buildBundle([
      fileEntry("index.html", PAYWALL_HTML),
      fileEntry("translations.json", JSON.stringify({ defaultLocale: "hi-Latn", translations: { "hi-Latn": { cta: "Aage" } } }), "application/json"),
    ]);
    expect(withBlock.localization).toEqual({ defaultLocale: "hi-Latn", translations: { "hi-Latn": { cta: "Aage" } } });

    const bareMap = await TranzmitImport.buildBundle([
      fileEntry("index.html", PAYWALL_HTML),
      fileEntry("translations.json", JSON.stringify({ en: { cta: "Continue" }, "hi-Latn": { cta: "Aage" } }), "application/json"),
    ]);
    expect(bareMap.localization.defaultLocale).toBe("en");
    expect(Object.keys(bareMap.localization.translations).sort()).toEqual(["en", "hi-Latn"]);
  });

  it("prefers index.html and resolves references relative to it", async () => {
    const nested = '<img src="../shared/logo.png">';
    const built = await TranzmitImport.buildBundle([
      fileEntry("pages/paywall.html", nested),
      fileEntry("shared/logo.png", PNG, "image/png"),
    ]);
    expect(built.entryPath).toBe("pages/paywall.html");
    expect(built.assets.map((asset: any) => asset.path)).toEqual(["shared/logo.png"]);
    expect(built.missingAssets).toEqual([]);
  });

  it("refuses a drop with no document", async () => {
    await expect(TranzmitImport.buildBundle([fileEntry("assets/hero.png", PNG, "image/png")]))
      .rejects.toThrow(/No .html file/);
  });
});
