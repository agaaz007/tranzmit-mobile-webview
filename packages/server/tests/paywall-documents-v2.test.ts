import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validatePublicKey: vi.fn(),
  getPlacementsForKey: vi.fn(),
  getConfigClient: vi.fn(),
  getPublishedDocument: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  validatePublicKey: mocks.validatePublicKey,
  getPlacementsForKey: mocks.getPlacementsForKey,
}));

vi.mock("../src/config-store.js", () => ({
  getConfigClient: mocks.getConfigClient,
  getPublishedDocument: mocks.getPublishedDocument,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validatePublicKey.mockResolvedValue(true);
  mocks.getConfigClient.mockResolvedValue({ id: "client-live" });
});

async function requestDocument(path: string): Promise<{ status: number; body: string; headers: Headers }> {
  const { handlePaywallDocument } = await import("../src/routes/paywall-documents.js");
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    void handlePaywallDocument(req, res, url.pathname);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.text(), headers: response.headers };
  } finally {
    server.close();
  }
}

describe("V2 immutable hosted documents", () => {
  it("serves an older published document from audit history after the current release changes", async () => {
    const oldPayload = {
      html: "<main>Previously published marriage paywall</main>",
      css: "main{color:#111}",
      cacheKey: "old-content-cache-key",
      revision: "content-revision-2",
      integrity: "sha256-old",
    };
    mocks.getPublishedDocument.mockResolvedValue({
      cacheKey: "old-content-cache-key",
      revision: "content-revision-2",
      documentHash: "old-document-hash",
      integrity: "sha256-old",
      payload: oldPayload,
    });
    // The legacy/current routing state is deliberately unrelated. A V2 URL is
    // resolved by immutable cache key history, not by today's placement row.
    mocks.getPlacementsForKey.mockResolvedValue([{ id: "a-different-current-placement" }]);

    const response = await requestDocument(
      "/v1/paywall-documents/placement-upgrade/marriage-03/old-content-cache-key.json?key=pk_live"
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(oldPayload);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe('W/"old-document-hash"');
    expect(mocks.getPublishedDocument).toHaveBeenCalledWith("client-live", "old-content-cache-key");
    expect(mocks.getPlacementsForKey).not.toHaveBeenCalled();
  });
});
