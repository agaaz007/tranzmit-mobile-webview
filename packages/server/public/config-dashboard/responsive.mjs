// Shared responsive preview matrix and in-frame QA checks.
//
// Keep this file beside build-preview.mjs: it is part of the harness, not
// runtime SDK code. The checks mirror the failures found while hardening the
// HiAstro LIVE legacy catalogue on 2026-08-24.

export const RESPONSIVE_DEVICES = [
  { id: "se1", label: "iPhone SE 1 · 320×568", width: 320, height: 568, dpr: 2, safeTop: 20, safeBottom: 0, safeLeft: 0, safeRight: 0, notch: false },
  { id: "android360", label: "Android · 360×640", width: 360, height: 640, dpr: 2, safeTop: 24, safeBottom: 24, safeLeft: 0, safeRight: 0, notch: false },
  { id: "se3", label: "iPhone SE 3 · 375×667", width: 375, height: 667, dpr: 2, safeTop: 20, safeBottom: 0, safeLeft: 0, safeRight: 0, notch: false },
  { id: "i14", label: "iPhone 14 · 390×844", width: 390, height: 844, dpr: 3, safeTop: 47, safeBottom: 34, safeLeft: 0, safeRight: 0, notch: true },
  { id: "android412", label: "Android · 412×915", width: 412, height: 915, dpr: 3, safeTop: 24, safeBottom: 24, safeLeft: 0, safeRight: 0, notch: false },
  { id: "max", label: "16 Pro Max · 430×932", width: 430, height: 932, dpr: 3, safeTop: 59, safeBottom: 34, safeLeft: 0, safeRight: 0, notch: true },
  { id: "ipad", label: "iPad · 768×1024", width: 768, height: 1024, dpr: 2, safeTop: 24, safeBottom: 20, safeLeft: 0, safeRight: 0, notch: false },
];

export const RESPONSIVE_LEARNINGS = [
  "Compose through the SDK. A raw browser misses safe areas, wrapper CSS, localization, and the real usable height.",
  "Test 320, 360, 375, 390, 412, and 430 px phone widths. A 390 px pass does not prove narrow phones.",
  "Use minmax(0, 1fr) for copy columns and min-width: 0 on grid/flex children so text may shrink and wrap.",
  "Let descriptive copy wrap. Reserve white-space: nowrap for atomic values such as ₹499 and short badges.",
  "Give prices an auto/max-content column. Never place price text on top of a copy column with absolute positioning.",
  "Keep one vertical scroller and a separate pinned CTA footer. Short screens should scroll, not squash cards.",
  "CTA labels need responsive horizontal padding, min-width: 0, and a fitting check at every width and locale.",
  "Render every configured locale. Missing localization tokens become empty strings in the SDK and can change layout.",
  "Treat deliberate ticker ellipsis and blurred locked teasers as explicit exceptions, not blanket overflow ignores.",
  "Verify image natural dimensions, card bounds, reminder/toggle collisions, and CTA bridge markup before shipping.",
];

export const TRIAL_BACK_FORBIDDEN = [
  'data-tranzmit-action="back"',
  "data-tranzmit-action='back'",
  "{{back_aria}}",
  "paywall:back",
  "M20 6L10 16l10 10",
];

export function assertSampleContract(sample, spec) {
  const assertions = sample.assertions || {};
  const source = `${spec.document?.html || ""}\n${spec.document?.css || ""}`;

  if (assertions.forbidBackAction) {
    const found = TRIAL_BACK_FORBIDDEN.find((token) => source.includes(token));
    if (found) throw new Error(`${sample.name || sample.id}: forbidden trial back control returned (${found})`);
  }

  if (assertions.defaultLocale) {
    const actual = spec.localization?.defaultLocale;
    if (actual !== assertions.defaultLocale) {
      throw new Error(`${sample.name || sample.id}: expected default locale ${assertions.defaultLocale}, got ${actual || "none"}`);
    }
  }

  for (const locale of assertions.requiredLocales || []) {
    if (!Object.hasOwn(spec.localization?.translations || {}, locale)) {
      throw new Error(`${sample.name || sample.id}: required locale ${locale} is missing`);
    }
  }
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Injected only into generated preview files. It never enters a paywall spec.
// Results are posted to the parent comparison sheet so every frame gets a
// visible PASS/FAIL badge without requiring Playwright or another dependency.
export function injectResponsiveAudit(html, meta) {
  const payload = safeJson(meta);
  const script = `
<script data-tranzmit-responsive-audit>
(() => {
  const META = ${payload};
  const rect = (value) => value ? ({
    left: value.left, right: value.right, top: value.top, bottom: value.bottom,
    width: value.width, height: value.height,
  }) : null;
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const textRect = (element) => {
    if (!element) return null;
    const boxes = [];
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      boxes.push(...[...range.getClientRects()].filter((box) => box.width > 0 && box.height > 0));
    }
    if (!boxes.length) return null;
    return {
      left: Math.min(...boxes.map((box) => box.left)),
      right: Math.max(...boxes.map((box) => box.right)),
      top: Math.min(...boxes.map((box) => box.top)),
      bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
  };
  const intersects = (left, right) => Boolean(left && right
    && Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1
    && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1);
  const label = (element) => element?.id ? "#" + element.id
    : element ? element.tagName.toLowerCase() + [...element.classList].slice(0, 3).map((name) => "." + name).join("") : "unknown";
  const intentionalOverflow = (element) => {
    if (element.closest("[data-tz-qa-ignore-overflow]")) return true;
    if (element.classList.contains("teaser")) return true;
    const style = getComputedStyle(element);
    return element.classList.contains("live-item") && style.overflow === "hidden" && style.textOverflow === "ellipsis";
  };

  async function run() {
    await document.fonts?.ready;
    await Promise.all([...document.images].map((image) => image.complete
      ? Promise.resolve()
      : new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const failures = [];
    const details = {};
    const documentWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
    if (documentWidth > innerWidth + 1) failures.push("horizontal overflow: " + documentWidth + "px > " + innerWidth + "px");

    const auditScript = document.querySelector("script[data-tranzmit-responsive-audit]");
    const auditedHtml = document.documentElement.innerHTML.replace(auditScript?.outerHTML || "", "");
    const unresolved = auditedHtml.match(/\{\{[^}]+\}\}/g) || [];
    if (unresolved.length) failures.push(unresolved.length + " unresolved localization token(s)");

    const overflowingText = [];
    for (const element of document.querySelectorAll("h1,h2,h3,p,strong,span,button,a,label")) {
      if (!visible(element) || element.classList.contains("sr-only") || intentionalOverflow(element)) continue;
      if (getComputedStyle(element).display === "inline") continue;
      const box = element.getBoundingClientRect();
      const text = textRect(element);
      if (text && (text.left < box.left - 1 || text.right > box.right + 1)) {
        overflowingText.push({ element: label(element), text: element.textContent.replace(/\s+/g, " ").trim().slice(0, 100) });
      }
    }
    if (overflowingText.length) failures.push(overflowingText.length + " painted text overflow(s)");

    const outsideComponents = [];
    for (const component of document.querySelectorAll(".card,.billing-card,.reminder,.stats,.activity-card,.insight-card")) {
      if (!visible(component)) continue;
      const bounds = component.getBoundingClientRect();
      for (const element of component.querySelectorAll("h1,h2,h3,p,strong,span,button,label")) {
        if (!visible(element) || element.classList.contains("sr-only") || intentionalOverflow(element)) continue;
        const text = textRect(element);
        if (text && (text.left < bounds.left - 1 || text.right > bounds.right + 1)) {
          outsideComponents.push({ component: label(component), element: label(element) });
        }
      }
    }
    if (outsideComponents.length) failures.push(outsideComponents.length + " component-bound overflow(s)");

    const billingCollisions = [];
    for (const row of document.querySelectorAll(".billing-row")) {
      const title = row.querySelector(".step-title");
      const price = row.querySelector(".step-price");
      if (intersects(textRect(title), rect(price?.getBoundingClientRect()))) {
        billingCollisions.push({ title: title?.textContent.trim(), price: price?.textContent.trim() });
      }
    }
    if (billingCollisions.length) failures.push(billingCollisions.length + " billing copy/price collision(s)");

    const reminderTitle = document.querySelector(".reminder-copy strong");
    const reminderSwitch = document.querySelector(".reminder-switch");
    if (intersects(textRect(reminderTitle), rect(reminderSwitch?.getBoundingClientRect()))) {
      failures.push("reminder title collides with toggle");
    }

    const insightCollisions = [];
    for (const insights of document.querySelectorAll(".insights")) {
      const labels = [...insights.querySelectorAll(":scope > .insight span")].map((element) => ({ element, box: textRect(element) }));
      for (let index = 0; index < labels.length; index += 1) {
        for (let next = index + 1; next < labels.length; next += 1) {
          if (intersects(labels[index].box, labels[next].box)) insightCollisions.push([label(labels[index].element), label(labels[next].element)]);
        }
      }
    }
    if (insightCollisions.length) failures.push(insightCollisions.length + " insight collision(s)");

    const ctas = [...document.querySelectorAll("[data-tranzmit-action='cta']")];
    if (!ctas.length) failures.push("CTA is missing");
    for (const cta of ctas) {
      const box = cta.getBoundingClientRect();
      if (!cta.textContent.trim()) failures.push("CTA text is empty");
      if (cta.scrollWidth > cta.clientWidth + 1) failures.push("CTA text overflows");
      if (box.left < -1 || box.right > innerWidth + 1) failures.push("CTA exceeds viewport horizontally");
    }

    const brokenImages = [...document.images].filter((image) => !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1);
    if (brokenImages.length) failures.push(brokenImages.length + " broken image(s)");

    if (META.forbidBackAction && (
      document.querySelector("[data-tranzmit-action='back']")
      || auditedHtml.includes("{{back_aria}}")
      || auditedHtml.includes("M20 6L10 16l10 10")
    )) failures.push("trial back control is present");

    details.overflowingText = overflowingText;
    details.outsideComponents = outsideComponents;
    details.billingCollisions = billingCollisions;
    details.insightCollisions = insightCollisions;
    const report = { type: "tranzmit-responsive-audit", ...META, passed: failures.length === 0, failures, details };
    window.__tranzmitResponsiveAudit = report;
    document.documentElement.dataset.tzQaStatus = report.passed ? "passed" : "failed";
    window.parent.postMessage(report, "*");
  }

  run().catch((error) => {
    const report = {
      type: "tranzmit-responsive-audit", ...META, passed: false,
      failures: ["audit error: " + (error?.message || String(error))], details: {},
    };
    window.__tranzmitResponsiveAudit = report;
    window.parent.postMessage(report, "*");
  });
})();
</script>`;

  return html.includes("</body>") ? html.replace("</body>", `${script}\n</body>`) : `${html}\n${script}`;
}
