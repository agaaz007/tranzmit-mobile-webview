import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const SEED_CLIENT_ID = process.env.SEED_CLIENT_ID || "client_influish_demo";
const SEED_PUBLIC_KEY = process.env.SEED_PUBLIC_KEY || "pk_test_2a8a5f07d4b9fcf1cc77e024";
const SEED_SECRET_KEY = process.env.SEED_SECRET_KEY || "sk_test_influish_demo";
const SEED_CLIENT_NAME = process.env.SEED_CLIENT_NAME || "Influish Demo";
const SEED_REVISION = process.env.SEED_REVISION || "seed-v5";

function webviewSpec({ templateId, title, subtitle, cta, product, features, socialProof, legal, presentation = "sheet" }) {
  const spec = {
    renderer: "webview",
    templateId,
    revision: SEED_REVISION,
    cacheKey: `${templateId}:${SEED_REVISION}`,
    presentation: { mode: presentation },
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
  if (spec.templateId === "influish_intro_offer") {
    const introPriceLabel = escapeHtml(product.name).replace(/(₹[0-9,]+)/, "<span>$1</span>");
    const featureHtml = features.map((feature, index) => {
      const icon = ["•••", "▣", "✦", "◆"][index % 4];
      return `<li><span class="icon">${icon}</span><span>${escapeHtml(feature.text)}</span><b>›</b></li>`;
    }).join("");
    return `<main class="tz-paywall ${spec.templateId}">
      <button class="tz-close tz-close-right" data-tranzmit-action="dismiss" aria-label="Close">×</button>
      <section class="brand intro-brand"><span class="mark">In</span><strong>Influish</strong><em>PRO</em></section>
      <h1>Unlock More Collabs.<br><span>Earn More.</span></h1>
      <p class="subtitle">${escapeHtml(spec.header.subtitle || "")}</p>
      <section class="offer intro-offer">
        ${product.badge ? `<div class="badge">✦ ${escapeHtml(product.badge)} ✦</div>` : ""}
        <div class="price-row intro-price"><strong>${introPriceLabel}</strong></div>
        <p class="price-sub">${escapeHtml(product.price)}</p>
        <div class="offer-divider"></div>
        ${product.description ? `<p class="monthly"><span>₹</span>${escapeHtml(product.description.replace(/^Just\s*/i, ""))}</p>` : ""}
      </section>
      <section class="creator-proof">
        <div class="avatars"><span></span><span></span><span></span><b>99+</b></div>
        <p>Trusted by <strong>8,20,737+</strong> creators<br><strong>₹2.3 Cr+</strong> paid out this year</p>
      </section>
      <section class="feature-panel"><h2>Why creators upgrade</h2><ul class="features">${featureHtml}</ul></section>
      <section class="testimonial intro-testimonial"><span class="avatar avatar-ananya"></span><div><strong>${escapeHtml(product.metadata?.testimonialName || "Ananya")} <small>· ${escapeHtml(product.metadata?.testimonialFollowers || "31K followers")}</small></strong><p>★★★★★</p><em>${escapeHtml(product.metadata?.testimonialText || "")}</em></div></section>
      <section class="legal-row"><span>▣ No hidden charges</span><span>↻ Cancel anytime</span><span>◇ Secure checkout</span></section>
      <button class="cta" data-tranzmit-action="cta" data-product-id="${escapeHtml(product.id)}">${escapeHtml(typeof spec.cta === "string" ? spec.cta : spec.cta.text)} <span>✦</span></button>
    </main>`;
  }
  if (spec.templateId === "influish_annual_pro") {
    const featureHtml = features.map((feature, index) => {
      const icon = ["•••", "▣", "✦"][index % 3];
      const [headline, detail = ""] = String(feature.text).split("|");
      return `<li><span class="icon">${icon}</span><strong>${escapeHtml(headline)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</li>`;
    }).join("");
    return `<main class="tz-paywall ${spec.templateId}">
      <button class="tz-close" data-tranzmit-action="dismiss" aria-label="Close">×</button>
      <section class="brand"><span class="mark">In</span><strong>Influish</strong></section>
      <h1>Start <span>Earning</span> with Pro</h1>
      <p class="subtitle">${escapeHtml(spec.header.subtitle || "")}</p>
      <section class="stats-row"><article><b>8,20,737+</b><small>creators trust Influish</small></article><article><b>42,000+</b><small>creators earning with Pro</small></article></section>
      <section class="offer annual-offer">
        ${product.badge ? `<div class="badge">★ ${escapeHtml(product.badge)}</div>` : ""}
        <div class="price-row annual-price"><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.price)}</span></div>
        ${product.description ? `<p class="monthly">${escapeHtml(product.description)}</p>` : ""}
        ${product.originalPrice ? `<p class="original">${escapeHtml(product.originalPrice)}</p>` : ""}
      </section>
      <ul class="features">${featureHtml}</ul>
      <section class="testimonial annual-testimonial"><span class="avatar avatar-riya"></span><div><strong>${escapeHtml(product.metadata?.testimonialName || "Riya")} <small>· ${escapeHtml(product.metadata?.testimonialFollowers || "58K followers")}</small></strong><p>“ ${escapeHtml(product.metadata?.testimonialText || "")} ”</p></div></section>
      <section class="legal-row"><span>▣ Secure payments</span><span>◖ Creator support</span><span>↻ Cancel anytime</span></section>
      <button class="cta" data-tranzmit-action="cta" data-product-id="${escapeHtml(product.id)}">${escapeHtml(typeof spec.cta === "string" ? spec.cta : spec.cta.text)}</button>
      <p class="guarantee">♡ 7-day money-back guarantee</p>
    </main>`;
  }
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
  return `html,body{margin:0;min-height:100%;background:transparent;overflow-x:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;color:${text};}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.tz-paywall{min-height:100svh;background:radial-gradient(circle at 50% 38%,rgba(118,59,232,.13),transparent 34%),linear-gradient(180deg,#fff 0%,#fbf8ff 100%);padding:clamp(18px,4.8vw,28px) clamp(18px,5.2vw,30px);padding-bottom:calc(clamp(84px,22vw,98px) + env(safe-area-inset-bottom));border-radius:clamp(20px,7vw,28px);text-align:center;position:relative;overflow-x:hidden;overflow-y:auto;display:flex;flex-direction:column;color:${text}}
.tz-close{position:absolute;left:clamp(14px,4vw,22px);top:clamp(14px,4vw,22px);border:0;background:#fff;border-radius:999px;width:42px;height:42px;font-size:34px;line-height:38px;color:#34303b;z-index:4;box-shadow:0 10px 28px rgba(25,20,40,.08)}
.tz-close-right{left:auto;right:clamp(16px,4vw,24px);background:transparent;box-shadow:none;color:#7d7784;font-size:36px}
.brand{display:flex;justify-content:center;align-items:center;gap:8px;font-size:clamp(20px,5.5vw,25px);font-weight:900;margin:clamp(8px,1.6vh,18px) 46px clamp(10px,2vh,18px)}
.mark{width:34px;height:38px;display:grid;place-items:center;background:${accent};color:#fff;font-family:Georgia,serif;font-weight:900;font-size:24px;clip-path:polygon(0 0,100% 0,100% 100%,50% 78%,0 100%)}
.brand em{background:${accent};color:#fff;border-radius:999px;padding:2px 8px;font-size:12px;font-style:normal;letter-spacing:.02em}
h1{font-size:clamp(35px,10.3vw,46px);line-height:1.04;margin:0;font-weight:950;letter-spacing:-.055em;text-wrap:balance}
h1 span{color:${accent}}
.subtitle{color:#6f6878;font-size:clamp(15px,4vw,17px);line-height:1.32;margin:clamp(8px,1.4vh,12px) auto 0;max-width:360px}
.offer{background:rgba(255,255,255,.94);border:1.5px solid rgba(113,58,225,.72);border-radius:26px;box-shadow:0 18px 38px rgba(101,55,217,.12),0 2px 0 rgba(255,255,255,.8) inset;position:relative}
.badge{position:absolute;left:50%;top:-18px;transform:translateX(-50%);background:linear-gradient(180deg,#f6c35d,#dfa536);color:#fff;border-radius:9px;padding:7px 16px;font-weight:900;font-size:14px;white-space:nowrap;box-shadow:0 7px 16px rgba(180,121,26,.22)}
.price-row strong{color:${accent};font-weight:950;letter-spacing:-.055em;overflow-wrap:anywhere}
.monthly{color:${accent};font-weight:900;margin:8px 0 0}
.original{text-decoration:line-through;color:#8b8492;margin:4px 0 0}
.features{list-style:none;padding:0;margin:0}
.icon{background:#f5f1ff;color:${accent};display:grid;place-items:center;flex:0 0 auto;font-weight:900}
.testimonial{background:#fff;border:1px solid #eeeaf4;box-shadow:0 12px 34px rgba(35,28,56,.05)}
.avatar{display:block;background:linear-gradient(135deg,#24162f,#f2d3c6);border-radius:50%;box-shadow:0 0 0 3px #fff}
.cta{border:0;border-radius:999px;background:linear-gradient(180deg,#8848f0,#612cdd);color:#fff;min-height:64px;font-size:clamp(20px,5.4vw,25px);font-weight:950;box-shadow:0 15px 34px rgba(101,55,217,.28);position:fixed;left:clamp(20px,5vw,42px);right:clamp(20px,5vw,42px);bottom:clamp(16px,4.5vw,24px);z-index:3}
.legal-row{display:flex;align-items:center;justify-content:space-around;gap:6px;color:#6f6878;font-size:12px;background:rgba(255,255,255,.84);border:1px solid #eeeaf4;border-radius:999px;padding:9px 12px}
.influish_intro_offer{gap:clamp(6px,1vh,10px)}
.influish_intro_offer h1{font-size:clamp(32px,9.55vw,42px)}
.influish_intro_offer .subtitle{margin-top:4px}
.intro-brand{margin-top:clamp(10px,2vh,20px)}
.intro-offer{margin:clamp(7px,1.2vh,11px) 28px 0;padding:22px 16px 12px;border-color:#eee7fb}
.intro-offer:before,.intro-offer:after{content:"";position:absolute;top:-18px;width:28px;height:24px;background:#c88d25;z-index:-1}.intro-offer:before{left:74px;transform:skewX(-25deg)}.intro-offer:after{right:74px;transform:skewX(25deg)}
.intro-price strong{font-size:clamp(29px,8.4vw,39px);letter-spacing:-.03em;color:#19162b}.intro-price strong span{color:${accent};font-size:1.48em}
.intro-price strong span,.intro-price strong{line-height:1}.price-sub{color:#7b7482;margin:8px 0 0;font-size:17px}.offer-divider{height:1px;background:#eeeaf4;margin:14px 18px 8px}.intro-offer .monthly{display:inline-flex;align-items:center;gap:6px;background:#f6f1ff;border-radius:999px;padding:7px 18px;font-size:15px}.intro-offer .monthly span{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:${accent};color:#fff}
.price-sub{margin:5px 0 0;font-size:16px}.offer-divider{margin:8px 20px 6px}.intro-offer .monthly{padding:5px 16px;font-size:14px}.intro-offer .monthly span{width:22px;height:22px}
.creator-proof{display:flex;align-items:center;justify-content:center;gap:12px;margin-top:2px}.avatars{display:flex;align-items:center}.avatars span,.avatars b{width:31px;height:31px;border-radius:50%;margin-left:-7px;border:2px solid #fff;background:linear-gradient(135deg,#29162c,#f2c4aa)}.avatars span:first-child{margin-left:0}.avatars span:nth-child(2){background:linear-gradient(135deg,#141a2f,#d7c7bb)}.avatars span:nth-child(3){background:linear-gradient(135deg,#2f2316,#f1d6b0)}.avatars b{display:grid;place-items:center;background:${accent};color:#fff;font-size:11px}.creator-proof p{margin:0;text-align:left;color:#5e5867;line-height:1.18;font-size:13px}.creator-proof strong{color:${accent};font-size:18px}
.feature-panel{background:#fff;border-radius:20px;padding:12px 14px 11px;text-align:left;box-shadow:0 14px 34px rgba(35,28,56,.06)}.feature-panel h2{font-size:17px;margin:0 0 7px}.feature-panel .features{display:grid;gap:0;border:1px solid #eeeaf4;border-radius:14px;overflow:hidden}.feature-panel li{display:grid;grid-template-columns:28px 1fr 10px;align-items:center;gap:8px;padding:7px 9px;border-bottom:1px solid #eeeaf4;font-size:12px;line-height:1.12}.feature-panel li:last-child{border-bottom:0}.feature-panel .icon{width:24px;height:24px;border-radius:7px}.feature-panel b{font-size:20px;color:${accent};font-weight:400}
.intro-testimonial{display:flex;align-items:center;gap:12px;border-radius:18px;padding:12px;text-align:left}.intro-testimonial .avatar{width:58px;height:58px}.intro-testimonial strong{display:block}.intro-testimonial small{font-weight:500;color:#7b7482}.intro-testimonial p{color:#e4b23e;letter-spacing:2px;margin:4px 0 2px}.intro-testimonial em{font-style:normal}.influish_intro_offer .legal-row{margin-top:0}
.influish_annual_pro{gap:clamp(12px,2vh,18px);padding-left:clamp(20px,7vw,48px);padding-right:clamp(20px,7vw,48px)}
.influish_annual_pro .brand{margin-top:clamp(8px,1.5vh,16px)}.influish_annual_pro h1{font-size:clamp(39px,11vw,50px)}.influish_annual_pro .subtitle{max-width:340px}
.stats-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stats-row article{background:#fff;border-radius:12px;padding:12px 10px;display:grid;gap:4px;box-shadow:0 12px 28px rgba(35,28,56,.06)}.stats-row b{color:${accent};font-size:19px}.stats-row small{font-size:12px;color:#6f6878}
.annual-offer{margin-top:6px;padding:34px 18px 24px}.annual-price{display:flex;align-items:flex-end;justify-content:center;gap:8px}.annual-price strong{font-size:clamp(72px,20vw,95px);line-height:.86}.annual-price span{font-size:22px;font-weight:900}.annual-offer .monthly{font-size:22px}.annual-offer .original{font-size:18px}
.influish_annual_pro .features{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.influish_annual_pro .features li{background:#fff;border-radius:14px;box-shadow:0 12px 28px rgba(35,28,56,.06);padding:16px 9px;display:grid;gap:7px;text-align:center;min-height:170px;align-content:start}.influish_annual_pro .features .icon{width:42px;height:42px;border-radius:14px;margin:0 auto}.influish_annual_pro .features strong{font-size:19px;line-height:1.07;letter-spacing:-.02em}.influish_annual_pro .features small{font-size:12px;color:#8b8492;line-height:1.28}
.annual-testimonial{display:flex;align-items:center;gap:14px;border-radius:20px;padding:13px 18px;text-align:left;position:relative;overflow:hidden}.annual-testimonial:after{content:"”";position:absolute;right:20px;top:-12px;color:#f2eaff;font-size:112px;font-weight:900}.annual-testimonial .avatar{width:64px;height:64px}.annual-testimonial strong{display:block}.annual-testimonial small{font-weight:500;color:#7b7482}.annual-testimonial p{font-style:italic;color:#332b44;margin:6px 0 0;line-height:1.34}.guarantee{position:fixed;left:0;right:0;bottom:calc(4px + env(safe-area-inset-bottom));margin:0;color:#8b8492;font-size:12px;text-align:center;z-index:3}
@media (max-width:360px){
  .influish_annual_pro .features strong{font-size:16px}
  .annual-price strong{font-size:64px}
  .intro-offer{margin-left:8px;margin-right:8px}
}
@media (max-height:700px){
  .tz-paywall{gap:8px;padding-top:12px}
  .brand{margin-bottom:4px}
  .subtitle{font-size:13px}
  .testimonial{display:none}
  .legal-row{display:none}
  .influish_annual_pro .features li{min-height:132px;padding:10px 6px}
}
@supports (bottom:max(0px)){
  .cta{bottom:max(clamp(14px,4vw,22px),env(safe-area-inset-bottom))}
}
.tz-presentation-fullscreen .tz-paywall{width:100vw!important;min-height:100svh!important;margin:0!important;border-radius:0!important;box-shadow:none!important}
.tz-presentation-fullscreen .tz-close,.tz-presentation-fullscreen .close{display:none!important}
.tz-presentation-sheet .tz-paywall,.tz-presentation-modal .tz-paywall{border-radius:clamp(20px,7vw,28px)}`;
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
      presentation: "fullscreen",
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
      presentation: "fullscreen",
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
      features: ["Get 3x more brand replies|Stand out, get noticed and close more deals.", "Unlock ₹10,000+ monthly brand deals|Get matched with high-paying brand campaigns.", "Access AI tools for hooks, captions & growth|Create better content, faster and smarter."],
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
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (public_key) DO UPDATE SET
         secret_key = EXCLUDED.secret_key,
         name = EXCLUDED.name,
         updated_at = now()
       RETURNING id, public_key`,
      [SEED_CLIENT_ID, SEED_PUBLIC_KEY, SEED_SECRET_KEY, SEED_CLIENT_NAME],
    );
    const workspaceId = workspace.rows[0].id;
    const publicKey = workspace.rows[0].public_key;

    const freeTrial = await upsertSpec(client, workspaceId, "freeTrial");
    const introOffer = await upsertSpec(client, workspaceId, "introOffer");
    const annualPro = await upsertSpec(client, workspaceId, "annualPro");

    const upgrade = await upsertPlacement(client, publicKey, "upgrade_pro", introOffer.id, introOffer.spec);
    await upsertVariant(client, upgrade, "control", introOffer.id, introOffer.spec, 0);
    await upsertVariant(client, upgrade, "free_trial", freeTrial.id, freeTrial.spec, 1);
    await upsertVariant(client, upgrade, "annual_pro", annualPro.id, annualPro.spec, 2);

    await client.query("COMMIT");
    console.log(`Seeded ${SEED_CLIENT_NAME} (${publicKey})`);
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
