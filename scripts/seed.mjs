import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function webviewSpec({ templateId, title, subtitle, cta, product, features, socialProof, legal }) {
  const spec = {
    renderer: "webview",
    templateId,
    revision: "seed-v1",
    cacheKey: `${templateId}:seed-v1`,
    header: { title, subtitle, alignment: "center" },
    cta: { text: cta },
    products: [product],
    features: features.map((text) => ({ text, included: true })),
    social_proof: socialProof ? { text: socialProof } : undefined,
    legal,
    style: {
      backgroundColor: "#fbfaff",
      accentColor: "#6537d9",
      textColor: "#17172e",
      secondaryTextColor: "#6f6878",
      cornerRadius: 28,
    },
    dismiss: { enabled: true, delay_ms: 0 },
    bridge: { version: 1, allowedActions: ["cta", "dismiss", "open_url", "custom_action"] },
  };
  spec.document = {
    html: buildHtml(spec),
    css: buildCss(spec),
  };
  return spec;
}

function buildHtml(spec) {
  const product = spec.products[0];
  const features = spec.features || [];
  const featureHtml = features.map((feature, index) => {
    const icon = ["💬", "💼", "🪄", "🛡"][index % 4];
    return `<li><span class="icon">${icon}</span><span>${escapeHtml(feature.text)}</span></li>`;
  }).join("");
  return `<main class="tz-paywall ${spec.templateId}">
    <button class="tz-close" data-tranzmit-action="dismiss" aria-label="Close">×</button>
    <section class="brand"><span class="mark">In</span><strong>Influish</strong></section>
    <h1>${escapeHtml(spec.header.title)}</h1>
    <p class="subtitle">${escapeHtml(spec.header.subtitle || "")}</p>
    ${spec.social_proof ? `<div class="social">${escapeHtml(spec.social_proof.text)}</div>` : ""}
    <section class="offer">
      ${product.badge ? `<div class="badge">${escapeHtml(product.badge)}</div>` : ""}
      <div class="price-row"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.price)}</span></div>
      ${product.description ? `<p class="monthly">${escapeHtml(product.description)}</p>` : ""}
      ${product.originalPrice ? `<p class="original">${escapeHtml(product.originalPrice)}</p>` : ""}
    </section>
    <ul class="features">${featureHtml}</ul>
    <section class="testimonial"><strong>${escapeHtml(product.metadata?.testimonialName || "Riya")}</strong><span> · ${escapeHtml(product.metadata?.testimonialFollowers || "58K followers")}</span><p>${escapeHtml(product.metadata?.testimonialText || "")}</p></section>
    <button class="cta" data-tranzmit-action="cta" data-product-id="${escapeHtml(product.id)}">${escapeHtml(typeof spec.cta === "string" ? spec.cta : spec.cta.text)}</button>
    <p class="legal">${escapeHtml(spec.legal || "")}</p>
  </main>`;
}

function buildCss(spec) {
  const accent = spec.style.accentColor;
  const bg = spec.style.backgroundColor;
  const text = spec.style.textColor;
  return `body{font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;background:transparent;color:${text};}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}.tz-paywall{min-height:100vh;background:${bg};padding:22px 22px 18px;border-radius:28px;text-align:center;position:relative;overflow:hidden}.tz-close{position:absolute;left:16px;top:16px;border:0;background:#fff;border-radius:999px;width:38px;height:38px;font-size:28px;color:#6f6878}.brand{display:flex;justify-content:center;align-items:center;gap:8px;font-size:24px;margin:8px 0 20px}.mark{background:${accent};color:#fff;padding:4px 6px;font-weight:900}h1{font-size:38px;line-height:1.08;margin:0 12px 10px;font-weight:900;letter-spacing:-1.4px}.subtitle{color:#6f6878;font-size:16px;line-height:1.4;margin:0 auto 18px;max-width:340px}.social{display:inline-block;background:#fff;border:1px solid #e8e1f6;border-radius:999px;padding:9px 14px;margin-bottom:18px;font-weight:800}.offer{background:#fff;border:1.5px solid ${accent};border-radius:24px;padding:28px 18px 20px;margin:10px 4px 18px;box-shadow:0 12px 28px rgba(101,55,217,.12);position:relative}.badge{position:absolute;left:50%;top:-15px;transform:translateX(-50%);background:#e6b246;color:#fff;border-radius:8px;padding:7px 18px;font-weight:900;font-size:13px}.price-row{display:flex;align-items:flex-end;justify-content:center;gap:8px}.price-row strong{color:${accent};font-size:56px;line-height:1;font-weight:900}.price-row span{font-size:22px;font-weight:800}.monthly{color:${accent};font-weight:900;font-size:18px;margin:8px 0 0}.original{text-decoration:line-through;color:#8b8492;margin:4px 0 0}.features{display:grid;grid-template-columns:1fr;gap:8px;list-style:none;padding:0;margin:0 0 16px}.features li{display:flex;align-items:center;gap:10px;background:#fff;border-radius:14px;padding:12px;text-align:left;font-weight:700}.icon{background:#f5f1ff;color:${accent};border-radius:10px;width:32px;height:32px;display:grid;place-items:center}.testimonial{background:#fff;border:1px solid #eeeaf4;border-radius:18px;padding:14px;margin-bottom:16px;text-align:left}.testimonial p{margin:6px 0 0;color:#3a3347}.cta{width:100%;border:0;border-radius:999px;background:${accent};color:#fff;min-height:58px;font-size:20px;font-weight:900;box-shadow:0 12px 24px rgba(101,55,217,.22)}.legal{color:#736d7c;font-size:12px;margin:10px 0 0}.influish_annual_pro .features{grid-template-columns:repeat(3,1fr)}.influish_annual_pro .features li{display:block;text-align:center;font-size:13px}.influish_intro_offer .offer{margin-top:22px}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const specs = {
  freeTrial: {
    name: "Influish 3-Day Free Trial",
    spec: webviewSpec({
      templateId: "influish_free_trial",
      title: "Get More Brand Deals & Grow Faster ✨",
      subtitle: "Unlock paid collabs, AI tools, faster payouts, and smarter creator growth.",
      cta: "Start Free Trial →",
      socialProof: "₹2.3 Cr+ earned by creators this year",
      legal: "No payment now · Cancel anytime before Day 3",
      product: {
        id: "influish_trial_yearly",
        name: "3-Day Free Trial",
        price: "Then ₹999/year",
        description: "Just ₹83/month",
        originalPrice: "₹5,988",
        badge: "Most Popular",
        isDefault: true,
        metadata: { testimonialName: "Shivani", testimonialFollowers: "24K followers", testimonialText: "Earned ₹12,500 in 18 days" },
      },
      features: ["Auto-reply to every DM — never miss a collab", "Get matched with paying brands", "Create viral hooks & captions with AI", "Guaranteed faster payouts"],
    }),
  },
  introOffer: {
    name: "Influish Intro Offer",
    spec: webviewSpec({
      templateId: "influish_intro_offer",
      title: "Unlock More Collabs. Earn More.",
      subtitle: "Upgrade to Influish Pro for brand deals, AI growth tools, and priority payouts.",
      cta: "Continue with Pro ✨",
      socialProof: "Trusted by 8,20,737+ creators · ₹2.3 Cr+ paid out this year",
      legal: "No hidden charges · Cancel anytime · Secure checkout",
      product: {
        id: "influish_intro_weekly",
        name: "Try for ₹49",
        price: "First week, then ₹999/year",
        description: "Just ₹83/month",
        badge: "Exclusive Intro Offer",
        isDefault: true,
        metadata: { testimonialName: "Ananya", testimonialFollowers: "31K followers", testimonialText: "Made ₹18,000 from brand deals after upgrading" },
      },
      features: ["Never miss a collab with auto-DM replies", "Apply to premium paid & barter campaigns", "Use AI tools to write hooks and captions", "Get priority support and safer payouts"],
    }),
  },
  annualPro: {
    name: "Influish Annual Pro",
    spec: webviewSpec({
      templateId: "influish_annual_pro",
      title: "Start Earning with Pro",
      subtitle: "Creators with Pro unlock more paid collabs, faster replies, and better earning tools.",
      cta: "Start Earning with Pro ✨",
      socialProof: "8,20,737+ creators trust Influish · 42,000+ creators earning with Pro",
      legal: "Secure payments · Creator support · Cancel anytime",
      product: {
        id: "influish_annual_yearly",
        name: "₹999",
        price: "/year",
        description: "Only ₹83/month",
        originalPrice: "₹5,988",
        badge: "Best Value",
        isDefault: true,
        metadata: { testimonialName: "Riya", testimonialFollowers: "58K followers", testimonialText: "Pro helped me land paid campaigns within weeks." },
      },
      features: ["Get 3x more brand replies", "Unlock ₹10,000+ monthly brand deals", "Access AI tools for hooks, captions & growth"],
    }),
  },
};

async function upsertSpec(client, workspaceId, key) {
  const item = specs[key];
  const result = await client.query(
    `INSERT INTO paywall_specs (workspace_id, name, spec, status, created_by)
     VALUES ($1, $2, $3, 'active', 'seed')
     ON CONFLICT (workspace_id, name) DO UPDATE SET
       spec = EXCLUDED.spec,
       status = 'active',
       updated_at = now()
     RETURNING id, spec`,
    [workspaceId, item.name, JSON.stringify(item.spec)]
  );
  return result.rows[0];
}

async function upsertPlacement(client, publicKey, trigger, defaultSpecId, defaultSpec, experimentId = null) {
  const result = await client.query(
    `INSERT INTO placements (
       id, public_key, trigger, enabled, status, variant_id, experiment_id,
       statsig_experiment_id, default_spec_id, targeting_rules, spec
     )
     VALUES ($1, $2, $3, true, 'active', 'control', $4, $4, $5, '[]'::jsonb, $6)
     ON CONFLICT (public_key, trigger) DO UPDATE SET
       enabled = true,
       status = 'active',
       variant_id = 'control',
       experiment_id = EXCLUDED.experiment_id,
       statsig_experiment_id = EXCLUDED.statsig_experiment_id,
       default_spec_id = EXCLUDED.default_spec_id,
       spec = EXCLUDED.spec,
       updated_at = now()
     RETURNING id`,
    [`pl_${trigger}`, publicKey, trigger, experimentId, defaultSpecId, JSON.stringify(defaultSpec)]
  );
  return result.rows[0].id;
}

async function upsertVariant(client, placementId, variantKey, specId, spec, fallbackRank) {
  await client.query(
    `INSERT INTO placement_variants (placement_id, variant_id, variant_key, spec_id, spec, enabled, status, weight, fallback_rank)
     VALUES ($1, $2, $2, $3, $4, true, 'active', 50, $5)
     ON CONFLICT (placement_id, variant_id) DO UPDATE SET
       variant_key = EXCLUDED.variant_key,
       spec_id = EXCLUDED.spec_id,
       spec = EXCLUDED.spec,
       enabled = true,
       status = 'active',
       fallback_rank = EXCLUDED.fallback_rank`,
    [placementId, variantKey, specId, JSON.stringify(spec), fallbackRank]
  );
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(
      `INSERT INTO clients (id, public_key, secret_key, name)
       VALUES ('client_test_demo', 'pk_test_demo', 'sk_test_demo', 'Test Workspace')
       ON CONFLICT (public_key) DO UPDATE SET
         secret_key = EXCLUDED.secret_key,
         name = EXCLUDED.name,
         updated_at = now()
       RETURNING id, public_key`,
    );
    const workspaceId = workspace.rows[0].id;
    const publicKey = workspace.rows[0].public_key;

    const freeTrial = await upsertSpec(client, workspaceId, "freeTrial");
    const introOffer = await upsertSpec(client, workspaceId, "introOffer");
    const annualPro = await upsertSpec(client, workspaceId, "annualPro");

    const upgrade = await upsertPlacement(client, publicKey, "upgrade_pro", freeTrial.id, freeTrial.spec);
    await upsertVariant(client, upgrade, "control", freeTrial.id, freeTrial.spec, 0);
    await upsertVariant(client, upgrade, "intro_offer", introOffer.id, introOffer.spec, 1);
    await upsertVariant(client, upgrade, "annual_pro", annualPro.id, annualPro.spec, 2);

    await client.query("COMMIT");
    console.log("Seeded Test Workspace (pk_test_demo / sk_test_demo)");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
