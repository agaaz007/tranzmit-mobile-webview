import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfigClient: vi.fn(),
  getV2PublishedRouting: vi.fn(),
  getV2PublishedReleases: vi.fn(),
  getPlacementsForKey: vi.fn(),
  getVariantAssignment: vi.fn(),
  getBaselineDecision: vi.fn(),
}));

vi.mock("../src/config-store.js", () => ({
  database: { query: vi.fn() },
  getEnvironmentPaywall: vi.fn(),
  withTransaction: vi.fn(),
  getConfigClient: mocks.getConfigClient,
  getV2PublishedRouting: mocks.getV2PublishedRouting,
  getV2PublishedReleases: mocks.getV2PublishedReleases,
}));

vi.mock("../src/db.js", () => ({
  getPlacementsForKey: mocks.getPlacementsForKey,
}));

vi.mock("../src/statsig.js", () => ({
  getVariantAssignment: mocks.getVariantAssignment,
  getBaselineDecision: mocks.getBaselineDecision,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfigClient.mockResolvedValue({
    id: "client-live",
    publicKey: "pk_live",
    projectKey: "hiastro",
    environmentKind: "live",
    managementStatus: "editable",
    configSource: "v2",
    sdkStack: "react_native",
    statsigProjectName: "hiastro",
    statsigServerSecretEnvVar: "STATSIG_HIASTRO",
  });
  mocks.getBaselineDecision.mockResolvedValue(null);
  mocks.getVariantAssignment.mockResolvedValue("arm-not-in-published-routing");
});

describe("V2 config resolution", () => {
  it("hydrates only the selected release and falls back to the published default for an unknown Statsig arm", async () => {
    mocks.getV2PublishedRouting.mockResolvedValue([
      {
        placementId: "placement-upgrade",
        revisionId: "routing-7",
        trigger: "upgrade_pro",
        status: "active",
        defaultVariantKey: "control",
        defaultBindingId: "binding-control",
        experimentId: "marriage_intent",
        targetingRules: [],
        variants: [
          {
            id: "route-control",
            variantId: "control",
            bindingId: "binding-control",
            status: "active",
            fallbackRank: 0,
            weight: 34,
          },
          {
            id: "route-trial",
            variantId: "marriage-02",
            bindingId: "binding-trial-reminder",
            status: "active",
            fallbackRank: 1,
            weight: 33,
          },
          {
            id: "route-marriage",
            variantId: "marriage-03",
            bindingId: "binding-marriage",
            status: "active",
            fallbackRank: 2,
            weight: 33,
          },
        ],
      },
    ]);
    mocks.getV2PublishedReleases.mockImplementation(async (_clientId: string, bindingIds: string[]) => {
      expect(bindingIds).toEqual(["binding-control"]);
      return new Map([
        ["binding-control", {
          bindingId: "binding-control",
          releaseId: "release-control",
          contentRevisionId: "content-control",
          content: {
            renderer: "webview",
            document: { html: "<main>Control</main>" },
            cta: { text: "Continue" },
            dismiss: { enabled: true },
          },
          products: [{ id: "live_yearly", name: "Live Pro", price: "₹999/year" }],
          checkout: { provider: { planId: "live_plan" } },
          documentPayload: {
            html: "<main>Control</main>",
            css: "main{color:#111}",
            cacheKey: "control-immutable",
            revision: "content-control",
            integrity: "sha256-control",
          },
        }],
      ]);
    });

    const { resolveConfigPlacements } = await import("../src/config-resolver.js");
    const resolved = await resolveConfigPlacements({
      publicKey: "pk_live",
      identity: {
        userId: "user-1",
        identifiers: { stableID: "stable-1" },
        traits: { intent: "marriage" },
      } as any,
      apiBaseUrl: "https://api.example.test",
      includeInline: false,
    });

    expect(mocks.getV2PublishedReleases).toHaveBeenCalledTimes(1);
    expect(mocks.getV2PublishedReleases).toHaveBeenCalledWith("client-live", ["binding-control"]);
    expect(mocks.getPlacementsForKey).not.toHaveBeenCalled();
    expect(mocks.getVariantAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ identifiers: { stableID: "stable-1" } }),
      "marriage_intent",
      "control",
      {
        projectName: "hiastro",
        serverSecretEnvVar: "STATSIG_HIASTRO",
      }
    );
    expect(resolved).toMatchObject({
      source: "v2",
      traces: [{
        assignedVariantId: "arm-not-in-published-routing",
        variant: "control",
      }],
      placements: {
        upgrade_pro: {
          variantId: "control",
          spec: {
            products: [{ id: "live_yearly" }],
            checkout: { provider: { planId: "live_plan" } },
            cacheKey: "control-immutable",
            document: {
              url: "https://api.example.test/v1/paywall-documents/placement-upgrade/control/control-immutable.json?key=pk_live",
            },
          },
        },
      },
    });
  });

  it("preserves var_default when a legacy placement has no variants or variant id", async () => {
    const content = {
      renderer: "webview",
      document: { html: "<main>Default</main>" },
      cta: { text: "Continue" },
      dismiss: { enabled: true },
    };
    const product = { id: "yearly", name: "Annual", price: "₹999/year" };
    mocks.getConfigClient.mockResolvedValueOnce({
      id: "client-live",
      configSource: "legacy",
    });
    mocks.getPlacementsForKey.mockResolvedValueOnce([{
      id: "placement-upgrade",
      trigger: "upgrade_pro",
      enabled: true,
      status: "active",
      default_variant_id: null,
      experiment_id: null,
      targeting_rules: [],
      statsig_project_name: null,
      statsig_server_secret_env_var: null,
      sdk_stack: "react_native",
      spec: { ...content, products: [product] },
      variants: [],
    }]);

    const { resolveConfigPlacements } = await import("../src/config-resolver.js");
    const input = {
      publicKey: "pk_live",
      identity: {
        userId: "user-1",
        identifiers: { stableID: "stable-1" },
        traits: {},
      } as any,
      apiBaseUrl: "https://api.example.test",
      includeInline: false,
    };
    const legacy = await resolveConfigPlacements(input);

    mocks.getConfigClient.mockResolvedValueOnce({
      id: "client-live",
      publicKey: "pk_live",
      projectKey: "hiastro",
      environmentKind: "live",
      managementStatus: "editable",
      configSource: "v2",
      sdkStack: "react_native",
      statsigProjectName: null,
      statsigServerSecretEnvVar: null,
    });
    mocks.getV2PublishedRouting.mockResolvedValueOnce([{
      placementId: "placement-upgrade",
      revisionId: "routing-default",
      trigger: "upgrade_pro",
      status: "active",
      defaultVariantKey: "var_default",
      defaultBindingId: "binding-default",
      experimentId: null,
      targetingRules: [],
      variants: [],
    }]);
    mocks.getV2PublishedReleases.mockResolvedValueOnce(new Map([
      ["binding-default", {
        bindingId: "binding-default",
        releaseId: "release-default",
        contentRevisionId: "content-default",
        content,
        products: [product],
        checkout: null,
        documentPayload: {
          html: "<main>Default</main>",
          cacheKey: "default-immutable",
          revision: "content-default",
          integrity: "sha256-default",
        },
      }],
    ]));
    const v2 = await resolveConfigPlacements(input);

    expect(legacy.placements.upgrade_pro?.variantId).toBe("var_default");
    expect(v2.placements.upgrade_pro?.variantId).toBe("var_default");
    expect(v2.traces[0]).toMatchObject({
      assignedVariantId: "var_default",
      variant: "var_default",
    });
  });
});
