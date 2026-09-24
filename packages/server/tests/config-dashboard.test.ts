import type { ServerResponse } from "node:http";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { serveConfigDashboard } from "../src/routes/config-dashboard.js";

function renderAsset(path: string): {
  served: boolean;
  body: string;
  status: number | undefined;
  headers: Record<string, string>;
} {
  let body = "";
  let status: number | undefined;
  let headers: Record<string, string> = {};
  let res: ServerResponse;
  res = {
    writeHead: (nextStatus: number, nextHeaders?: Record<string, string>) => {
      status = nextStatus;
      headers = nextHeaders || {};
      return res;
    },
    end: (chunk?: unknown) => {
      body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
      return res;
    },
  } as unknown as ServerResponse;

  return {
    served: serveConfigDashboard(res, path),
    get body() { return body; },
    get status() { return status; },
    get headers() { return headers; },
  };
}

describe("V2 config dashboard assets", () => {
  it("serves a small static shell without customer templates or remote fonts", () => {
    const asset = renderAsset("/config-dashboard");

    expect(asset.served).toBe(true);
    expect(asset.status).toBe(200);
    expect(asset.headers["Content-Type"]).toContain("text/html");
    expect(asset.headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(asset.body).toContain('/config-dashboard/styles.css');
    expect(asset.body).toContain('/config-dashboard/app.js');
    expect(asset.body).toContain("Exact document preview");
    expect(asset.body).toContain("Localization JSON");
    expect(asset.body).toContain("Products JSON");
    expect(asset.body).toContain("Checkout JSON");
    expect(asset.body).not.toContain("STANDALONE_PAYWALL_HTML_BY_TEMPLATE");
    expect(asset.body).not.toContain("fonts.googleapis.com");
    expect(asset.body).not.toContain("data:font");
  });

  it("serves valid dashboard JavaScript with V2 candidate and pointer operations", () => {
    const asset = renderAsset("/config-dashboard/app.js");

    expect(asset.served).toBe(true);
    expect(asset.status).toBe(200);
    expect(asset.headers["Content-Type"]).toContain("text/javascript");
    expect(() => new Function(asset.body)).not.toThrow();
    expect(asset.body).toContain('"/admin/v2/environments"');
    expect(asset.body).toContain('"/admin/paywalls/"');
    expect(asset.body).toContain('"/releases"');
    expect(asset.body).toContain('"/publish"');
    expect(asset.body).toContain('"/rollback"');
    expect(asset.body).toContain('"/promote"');
    expect(asset.body).toContain("expectedCurrentReleaseId");
    expect(asset.body).toContain("expectedCurrentRevisionId");
    expect(asset.body).toContain("error.status === 409");
    expect(asset.body).toContain('management_status === "legacy_locked"');
  });

  it("uses a fixed asset allowlist", () => {
    expect(renderAsset("/config-dashboard/styles.css").served).toBe(true);
    expect(renderAsset("/config-dashboard/../../package.json").served).toBe(false);
    expect(renderAsset("/config-dashboard/unknown.js").served).toBe(false);
  });

  it("loads grouped environments and renders a paywall from the V2 API", async () => {
    const html = renderAsset("/config-dashboard").body;
    const script = renderAsset("/config-dashboard/app.js").body;
    const dom = new JSDOM(html, {
      url: "https://dashboard.example/config-dashboard",
      runScripts: "outside-only",
    });
    const responses: Record<string, unknown> = {
      "/admin/v2/environments": [{
        id: "env-test",
        public_key: "pk_test_one",
        name: "Test",
        project_key: "hiastro",
        environment_kind: "test",
        management_status: "editable",
        config_source: "v2",
        sdk_stack: "react_native",
      }],
      "/admin/paywalls?public_key=pk_test_one": [{
        binding_id: "binding-one",
        paywall_id: "paywall-one",
        paywall_key: "trial-reminder",
        display_name: "Trial reminder",
        current_release_id: "release-one",
        current_release_number: 1,
      }],
      "/admin/v2/placements?public_key=pk_test_one": [],
      "/admin/paywalls/binding-one": {
        binding_id: "binding-one",
        paywall_id: "paywall-one",
        paywall_key: "trial-reminder",
        display_name: "Trial reminder",
        current_release_id: "release-one",
        releases: [{
          id: "release-one",
          release_number: 1,
          content_hash: "abcdef1234567890",
          content: {
            document: { html: "<main>{{title}}</main>", css: "main{color:green}" },
            localization: { defaultLocale: "en", translations: { en: { title: "Trial reminder" } } },
          },
          products: [{ id: "annual", name: "Annual", price: "999" }],
          checkout: null,
          is_current: true,
        }],
      },
    };
    (dom.window as any).fetch = async (url: string) => ({
      ok: Object.prototype.hasOwnProperty.call(responses, url),
      status: Object.prototype.hasOwnProperty.call(responses, url) ? 200 : 404,
      text: async () => JSON.stringify(responses[url] ?? { error: "Not found" }),
    });

    dom.window.eval(script);
    await settle();

    const select = dom.window.document.getElementById("environmentSelect") as HTMLSelectElement;
    expect(select.querySelector("optgroup")?.label).toBe("hiastro");
    expect(dom.window.document.getElementById("collectionList")?.textContent).toContain("Trial reminder");

    (dom.window.document.querySelector(".collection-item") as HTMLButtonElement).click();
    await settle();
    expect(dom.window.document.getElementById("paywallName")?.textContent).toBe("Trial reminder");
    expect((dom.window.document.getElementById("documentHtml") as HTMLTextAreaElement).value)
      .toBe("<main>{{title}}</main>");
    expect((dom.window.document.getElementById("productsJson") as HTMLTextAreaElement).value)
      .toContain('"id": "annual"');
  });

  it("keeps a placement's fixed-split settings when a routing edit is saved", async () => {
    const html = renderAsset("/config-dashboard").body;
    const script = renderAsset("/config-dashboard/app.js").body;
    const dom = new JSDOM(html, {
      url: "https://dashboard.example/config-dashboard",
      runScripts: "outside-only",
    });
    const fixedSplitRevision = {
      id: "rev-3",
      revision_number: 3,
      status: "active",
      is_current: true,
      default_binding_id: "binding-one",
      default_variant_key: "control",
      statsig_experiment_id: null,
      targeting_rules: [],
      assignment_mode: "fixed_split",
      holdout_percent: "10.00",
      assignment_salt: "marriage-exp-2026-09",
      variants: [
        { variant_key: "control", binding_id: "binding-one", status: "active", weight: 1, fallback_rank: 0, eligibility: null },
        { variant_key: "marriage-02", binding_id: "binding-one", status: "active", weight: 1, fallback_rank: 1, eligibility: { intent: ["marriage"] } },
      ],
    };
    const responses: Record<string, unknown> = {
      "/admin/v2/environments": [{
        id: "env-test",
        public_key: "pk_test_one",
        name: "Test",
        project_key: "hiastro",
        environment_kind: "test",
        management_status: "editable",
        config_source: "v2",
        sdk_stack: "react_native",
      }],
      "/admin/paywalls?public_key=pk_test_one": [{
        binding_id: "binding-one",
        paywall_id: "paywall-one",
        paywall_key: "trial-reminder",
        display_name: "Trial reminder",
        current_release_id: "release-one",
        current_release_number: 1,
      }],
      "/admin/v2/placements?public_key=pk_test_one": [{
        placement_id: "pl_upgrade",
        trigger: "upgrade_pro",
        current_revision_id: "rev-3",
        current_revision_number: 3,
        status: "active",
      }],
      "/admin/placements/pl_upgrade/revisions": {
        placement: { id: "pl_upgrade", current_revision_id: "rev-3" },
        revisions: [fixedSplitRevision],
      },
    };
    const posted: unknown[] = [];
    (dom.window as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: "rev-4" }) };
      }
      return {
        ok: Object.prototype.hasOwnProperty.call(responses, url),
        status: Object.prototype.hasOwnProperty.call(responses, url) ? 200 : 404,
        text: async () => JSON.stringify(responses[url] ?? { error: "Not found" }),
      };
    };

    dom.window.eval(script);
    await settle();
    (dom.window.document.querySelector('[data-section="placements"]') as HTMLButtonElement).click();
    await settle();
    (dom.window.document.querySelector(".collection-item") as HTMLButtonElement).click();
    await settle();
    expect((dom.window.document.getElementById("variantsJson") as HTMLTextAreaElement).value)
      .toContain('"eligibility"');
    (dom.window.document.getElementById("savePlacementButton") as HTMLButtonElement).click();
    await settle();

    expect(posted).toEqual([expect.objectContaining({
      assignmentMode: "fixed_split",
      holdoutPercent: 10,
      assignmentSalt: "marriage-exp-2026-09",
      variants: [
        { variantKey: "control", bindingId: "binding-one", status: "active", weight: 1, fallbackRank: 0 },
        {
          variantKey: "marriage-02",
          bindingId: "binding-one",
          status: "active",
          weight: 1,
          fallbackRank: 1,
          eligibility: { intent: ["marriage"] },
        },
      ],
    })]);
  });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}
