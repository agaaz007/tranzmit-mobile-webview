import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetRoots = [
  path.resolve(process.cwd(), "packages/server/public/assets"),
  path.resolve(process.cwd(), "public/assets"),
  path.resolve(__dirname, "../../public/assets"),
];

const contentTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export async function handleAsset(res: ServerResponse, requestPath: string): Promise<void> {
  const relativePath = decodeURIComponent(requestPath.replace(/^\/assets\//, ""));
  if (!relativePath || relativePath.includes("\0") || relativePath.split(/[\\/]/).includes("..")) {
    sendNotFound(res);
    return;
  }

  for (const root of assetRoots) {
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(root + path.sep)) continue;

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) continue;

      res.writeHead(200, {
        "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "Content-Length": fileStat.size,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      createReadStream(filePath).pipe(res);
      return;
    } catch {
      // Try the next root.
    }
  }

  sendNotFound(res);
}

function sendNotFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Asset not found" }));
}
