import assert from "node:assert/strict";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i];
    if (!part.startsWith("--")) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { response, json };
}

const validSpec = {
  layout: "minimal",
  header: {
    title: "Smoke Test Paywall",
    subtitle: "Verifies hot-swapped specs are served from the config API.",
    alignment: "center",
  },
  products: [
    {
      id: "smoke_monthly",
      name: "Smoke Monthly",
      price: "$1.00/mo",
      isDefault: true,
    },
  ],
  cta: { text: "Run Smoke" },
  style: {
    backgroundColor: "#ffffff",
    accentColor: "#2563eb",
    textColor: "#111827",
  },
  dismiss: { enabled: true, delay_ms: 0 },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = (args.base || process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const secret = args.secret || process.env.ADMIN_SECRET || "sk_test_demo";
  const publicKey = args["public-key"] || process.env.PUBLIC_KEY || "pk_test_demo";
  const suffix = Date.now().toString(36);
  const trigger = `smoke_${suffix}`;

  const adminHeaders = {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };

  const invalid = await requestJson(`${base}/admin/specs`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ name: `Invalid ${suffix}`, spec: { layout: "minimal" } }),
  });
  assert.equal(invalid.response.status, 400, "invalid spec should be rejected");

  const createdSpec = await requestJson(`${base}/admin/specs`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      public_key: publicKey,
      name: `Smoke Spec ${suffix}`,
      status: "active",
      spec: validSpec,
    }),
  });
  assert.equal(createdSpec.response.status, 201, "spec create should return 201");
  assert.ok(createdSpec.json.id, "created spec should include id");

  const fetchedSpec = await requestJson(`${base}/admin/specs/${createdSpec.json.id}`, {
    headers: adminHeaders,
  });
  assert.equal(fetchedSpec.response.status, 200, "spec fetch should return 200");
  assert.equal(fetchedSpec.json.spec.header.title, validSpec.header.title);

  const createdPlacement = await requestJson(`${base}/admin/placements`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      public_key: publicKey,
      trigger,
      default_spec_id: createdSpec.json.id,
    }),
  });
  assert.equal(createdPlacement.response.status, 201, "placement create should return 201");
  assert.ok(createdPlacement.json.id, "created placement should include id");

  const createdVariant = await requestJson(`${base}/admin/placements/${createdPlacement.json.id}/variants`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      variant_key: "control",
      spec_id: createdSpec.json.id,
    }),
  });
  assert.equal(createdVariant.response.status, 201, "variant create should return 201");

  const firstConfig = await requestJson(`${base}/v1/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      public_key: publicKey,
      identity: { userId: `smoke_user_${suffix}`, identifiers: { stableID: `stable_${suffix}` } },
    }),
  });
  assert.equal(firstConfig.response.status, 200, "config fetch should return 200");
  assert.equal(firstConfig.json.placements[trigger].spec.header.title, validSpec.header.title);
  assert.equal(firstConfig.json.placements[trigger].placement_id, createdPlacement.json.id);
  assert.ok(firstConfig.json.placements[trigger].variant_key, "config should include variant_key");

  const updatedTitle = "Smoke Test Paywall Updated";
  const updatedSpec = {
    ...validSpec,
    header: { ...validSpec.header, title: updatedTitle },
  };
  const updated = await requestJson(`${base}/admin/specs/${createdSpec.json.id}`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      name: `Smoke Spec ${suffix}`,
      spec: updatedSpec,
    }),
  });
  assert.equal(updated.response.status, 200, "spec update should return 200");
  assert.equal(updated.json.version, createdSpec.json.version + 1);

  const secondConfig = await requestJson(`${base}/v1/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      public_key: publicKey,
      identity: { userId: `smoke_user_${suffix}`, identifiers: { stableID: `stable_${suffix}` } },
    }),
  });
  assert.equal(secondConfig.json.placements[trigger].spec.header.title, updatedTitle, "updated spec should hot-swap into config");

  const paused = await requestJson(`${base}/admin/placements/${createdPlacement.json.id}/status`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ status: "paused" }),
  });
  assert.equal(paused.response.status, 200, "placement pause should return 200");

  const pausedConfig = await requestJson(`${base}/v1/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      public_key: publicKey,
      identity: { userId: `smoke_user_${suffix}`, identifiers: { stableID: `stable_${suffix}` } },
    }),
  });
  assert.equal(pausedConfig.json.placements[trigger], null, "paused placement should resolve to null");

  console.log(JSON.stringify({
    base,
    publicKey,
    trigger,
    specId: createdSpec.json.id,
    placementId: createdPlacement.json.id,
    status: "ok",
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
