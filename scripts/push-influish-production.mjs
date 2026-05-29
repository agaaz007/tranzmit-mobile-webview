import { spawnSync } from "node:child_process";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_HOST = process.env.TRANZMIT_API_HOST || "api-production-2146.up.railway.app";
const PUBLIC_KEY = process.env.SEED_PUBLIC_KEY || "pk_live_a1323f76d397778b6ed5eb04";
const ADMIN_SECRET = process.env.ADMIN_SECRET;

if (!ADMIN_SECRET) {
  console.error("Missing ADMIN_SECRET");
  process.exit(1);
}

function exportPayload() {
  const result = spawnSync(process.execPath, ["scripts/seed.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SEED_EXPORT_JSON: "1",
      SEED_PUBLIC_KEY: PUBLIC_KEY,
      SEED_ANNUAL_PRICE: process.env.SEED_ANNUAL_PRICE || "499",
      SEED_VARIANT_PROFILE: "influish_production",
      SEED_INCLUDE_ORIGINAL_PAYWALL: "false",
      SEED_REVISION: process.env.SEED_REVISION || "prod-v2",
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }

  return JSON.parse(result.stdout);
}

function request(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: API_HOST,
        path: pathName,
        method,
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": ADMIN_SECRET,
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, body: text, json: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const payload = exportPayload();
  const placementId = payload.placements[0].id;

  for (const spec of payload.specs) {
    const res = await request("POST", "/admin/config/import", {
      publicKey: payload.publicKey,
      specs: [spec],
    });
    console.log("spec", spec.name, res.status);
    if (res.status >= 400) {
      console.error(res.body);
      process.exit(1);
    }
  }

  const specsRes = await request("GET", `/admin/specs?publicKey=${encodeURIComponent(PUBLIC_KEY)}`);
  const specsByName = Object.fromEntries((specsRes.json || []).map((spec) => [spec.name, spec.id]));
  const defaultSpecName = payload.specs.find((spec) => spec.id === payload.placements[0].default_spec_id)?.name;

  const placementRes = await request("POST", "/admin/config/import", {
    publicKey: payload.publicKey,
    placements: payload.placements.map((placement) => ({
      ...placement,
      default_spec_id: specsByName[defaultSpecName],
    })),
  });
  console.log("placement", placementRes.status);
  if (placementRes.status >= 400) {
    console.error(placementRes.body);
    process.exit(1);
  }

  const placementsRes = await request("GET", "/admin/placements");
  const placement = (placementsRes.json || []).find(
    (item) => item.public_key === PUBLIC_KEY && item.trigger === "upgrade_pro",
  );
  const resolvedPlacementId = placement?.id || placementId;

  for (const variant of payload.variants) {
    const specName = payload.specs.find((spec) => spec.id === variant.spec_id)?.name;
    const specId = specsByName[specName];
    const res = await request("POST", `/admin/placements/${resolvedPlacementId}/variants`, {
      variant_key: variant.variant_key,
      spec_id: specId,
      weight: variant.weight,
    });
    console.log("variant", variant.variant_key, res.status, specName);
    if (res.status >= 400) {
      console.error(res.body);
      process.exit(1);
    }
  }

  for (const staleKey of ["free_trial", "annual_pro", "original_paywall"]) {
    const res = await request(
      "DELETE",
      `/admin/placements/${resolvedPlacementId}/variants/${encodeURIComponent(staleKey)}`,
    );
    if (res.status === 200) console.log("removed stale variant", staleKey);
  }

  console.log(
    "Influish Production paywalls pushed:",
    payload.variants.map((variant) => variant.variant_key).join(", "),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
