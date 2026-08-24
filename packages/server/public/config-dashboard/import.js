/**
 * Paywall import: turn a dropped export folder into a publishable candidate,
 * then measure how it actually renders.
 *
 * Everything here runs in the browser on purpose. The document has to be built
 * before it can be validated, and building it means decoding and re-encoding
 * images — work the control-plane server has no image library for and no reason
 * to spend CPU on. Rendering has to happen in a browser by definition. The
 * server still re-validates the finished spec, so nothing here is trusted; it is
 * only what makes the drop-and-submit flow possible.
 */
(function () {
  "use strict";

  var IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif)$/i;
  var ASSET_EXTENSIONS = /\.(png|jpe?g|webp|gif|avif|svg|woff2?|ttf|otf)$/i;
  var ASSET_ATTRIBUTES = "src|href|data-tranzmit-src|data-tranzmit-fallback-src";

  /**
   * Asset classes mirror templates/push-hiastro.mjs. Avatars are opaque photos
   * that survive lossy encoding; icons are small on screen; everything else is
   * illustration. Every ceiling comfortably exceeds 3x retina at display size.
   */
  var ASSET_CLASSES = [
    { test: /^avatar_/i, maxSide: 384, quality: 0.82 },
    { test: /^(stat_|icon_|chip_|proof_|slots_)/i, maxSide: 256, quality: 0.9 },
    { test: /.*/, maxSide: 512, quality: 0.9 },
  ];

  /**
   * The full-bleed flatten layer, byte-identical to the one push-hiastro.mjs
   * bakes. Legacy `.device` / `.screen` paywalls were authored against an older
   * skeleton and self-correct only when this is present. Modern `tz-template`
   * documents already do all of it, which is why it is opt-in.
   */
  var FLATTEN_CSS = [
    "/* === Tranzmit full-bleed flatten (baked; works regardless of SDK version) === */",
    "body { padding: 0 !important; margin: 0 !important; }",
    ".device {",
    "  width: 100% !important; max-width: 100vw !important;",
    "  min-height: var(--tz-vh, 100dvh) !important;",
    "  margin: 0 !important; padding: 0 !important;",
    "  border-radius: 0 !important; background: transparent !important; box-shadow: none !important;",
    "}",
    ".screen, .paywall-screen {",
    "  height: var(--tz-vh, 100dvh) !important;",
    "  min-height: var(--tz-vh, 100dvh) !important;",
    "  max-height: var(--tz-vh, 100dvh) !important;",
    "  border-radius: 0 !important;",
    "  display: block !important;",
    "  overflow-y: auto !important;",
    "  -webkit-overflow-scrolling: touch !important;",
    "}",
    ".screen > .content, .paywall-screen > .content, .screen > .sheet, .paywall-screen > .sheet {",
    "  box-sizing: border-box !important;",
    "  min-height: 100% !important;",
    "  margin: 0 !important;",
    "  display: flex !important;",
    "  flex-direction: column !important;",
    "  padding-top: calc(var(--tz-safe-top, env(safe-area-inset-top, 0px)) + clamp(10px, 2vh, 18px)) !important;",
    "  padding-bottom: calc(var(--tz-safe-bottom, env(safe-area-inset-bottom, 0px)) + clamp(10px, 1.6vh, 16px)) !important;",
    "  padding-left: calc(var(--tz-safe-left, env(safe-area-inset-left, 0px)) + clamp(14px, 4.5vw, 20px)) !important;",
    "  padding-right: calc(var(--tz-safe-right, env(safe-area-inset-right, 0px)) + clamp(14px, 4.5vw, 20px)) !important;",
    "}",
    ".screen > .content > :first-child, .paywall-screen > .content > :first-child,",
    ".screen > .sheet > :first-child, .paywall-screen > .sheet > :first-child { margin-top: auto !important; }",
    ".screen .cta, .paywall-screen .cta { margin-top: auto !important; }",
    ".screen .cta ~ *, .paywall-screen .cta ~ * { margin-top: 0 !important; }",
    ".screen .cta, .paywall-screen .cta {",
    "  min-height: clamp(60px, 7.5vh, 72px) !important;",
    "  padding: clamp(16px, 2vh, 22px) clamp(20px, 5vw, 28px) !important;",
    "  font-size: clamp(16px, 4.4vw, 19px) !important;",
    "  line-height: 1.1 !important;",
    "}",
    ".screen .cta .cta-label, .paywall-screen .cta .cta-label {",
    "  font-size: clamp(16px, 4.4vw, 19px) !important;",
    "  line-height: 1.1 !important;",
    "}",
    ".decor, .decor-top, .decor-bottom, .decor-left, .decor-right,",
    ".decor-top-right, .decor-bottom-left, .decor-left-mid,",
    ".price-watermark { display: none !important; }",
    "/* === end Tranzmit flatten === */",
  ].join("\n");

  var FLATTEN_MARKER = "Tranzmit full-bleed flatten (baked";

  // --- Reading dropped files ------------------------------------------------

  /** Normalizes a FileList (folder picker) into {path, file} entries. */
  function filesFromInput(fileList) {
    var entries = [];
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      entries.push({ path: file.webkitRelativePath || file.name, file: file });
    }
    return stripCommonRoot(entries);
  }

  /** Walks a drop, expanding directories, and returns {path, file} entries. */
  async function filesFromDataTransfer(dataTransfer) {
    var items = Array.prototype.slice.call(dataTransfer.items || []);
    var roots = items
      .map(function (item) {
        return item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      })
      .filter(Boolean);

    if (!roots.length) {
      return stripCommonRoot(Array.prototype.slice.call(dataTransfer.files || []).map(function (file) {
        return { path: file.name, file: file };
      }));
    }

    var entries = [];
    for (var i = 0; i < roots.length; i++) await walkEntry(roots[i], "", entries);
    return stripCommonRoot(entries);
  }

  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      var file = await new Promise(function (resolve, reject) {
        entry.file(resolve, reject);
      });
      out.push({ path: prefix + entry.name, file: file });
      return;
    }
    if (!entry.isDirectory) return;
    var reader = entry.createReader();
    var batch;
    do {
      batch = await new Promise(function (resolve, reject) {
        reader.readEntries(resolve, reject);
      });
      for (var i = 0; i < batch.length; i++) {
        await walkEntry(batch[i], prefix + entry.name + "/", out);
      }
    } while (batch.length > 0);
  }

  /**
   * Drops the wrapper directory so `my-paywall/index.html` and a bare
   * `index.html` produce the same bundle paths.
   */
  function stripCommonRoot(entries) {
    if (entries.length === 0) return entries;
    var segments = entries.map(function (entry) { return entry.path.split("/"); });
    if (segments.some(function (parts) { return parts.length < 2; })) return entries;
    var root = segments[0][0];
    if (!segments.every(function (parts) { return parts[0] === root; })) return entries;
    return entries.map(function (entry, index) {
      return { path: segments[index].slice(1).join("/"), file: entry.file };
    });
  }

  // --- Building the document ------------------------------------------------

  function htmlCandidates(entries) {
    return entries
      .filter(function (entry) { return /\.html?$/i.test(entry.path); })
      .map(function (entry) { return entry.path; })
      .sort(function (a, b) {
        var aIndex = /(^|\/)index\.html?$/i.test(a) ? 0 : 1;
        var bIndex = /(^|\/)index\.html?$/i.test(b) ? 0 : 1;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return a.localeCompare(b);
      });
  }

  function readWith(method, file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader[method](file);
    });
  }

  function readText(file) {
    return readWith("readAsText", file);
  }

  function readArrayBuffer(file) {
    return readWith("readAsArrayBuffer", file);
  }

  function assetClassFor(name) {
    for (var i = 0; i < ASSET_CLASSES.length; i++) {
      if (ASSET_CLASSES[i].test.test(name)) return ASSET_CLASSES[i];
    }
    return ASSET_CLASSES[ASSET_CLASSES.length - 1];
  }

  function baseName(path) {
    var parts = path.split("/");
    return parts[parts.length - 1];
  }

  function bytesToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunk = 0x8000;
    var pieces = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      pieces.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(pieces.join(""));
  }

  function mimeFor(path) {
    var ext = (path.split(".").pop() || "").toLowerCase();
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "webp") return "image/webp";
    if (ext === "gif") return "image/gif";
    if (ext === "avif") return "image/avif";
    if (ext === "svg") return "image/svg+xml";
    if (ext === "woff2") return "font/woff2";
    if (ext === "woff") return "font/woff";
    if (ext === "ttf") return "font/ttf";
    if (ext === "otf") return "font/otf";
    return "application/octet-stream";
  }

  async function blobToDataUri(blob) {
    return await new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Re-encodes one image to WebP within its class ceiling. Falls back to the
   * original bytes whenever re-encoding is impossible (SVG, unsupported codec)
   * or simply not smaller — the point is a lighter document, never a worse one.
   */
  async function encodeAsset(path, file) {
    var original = await readArrayBuffer(file);
    var originalUri = "data:" + mimeFor(path) + ";base64," + bytesToBase64(original);
    if (!IMAGE_EXTENSIONS.test(path) || typeof createImageBitmap !== "function") {
      return { uri: originalUri, before: original.byteLength, after: original.byteLength, recoded: false };
    }

    try {
      var bitmap = await createImageBitmap(file);
      var cls = assetClassFor(baseName(path));
      var scale = Math.min(1, cls.maxSide / Math.max(bitmap.width, bitmap.height));
      var width = Math.max(1, Math.round(bitmap.width * scale));
      var height = Math.max(1, Math.round(bitmap.height * scale));
      var canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
      bitmap.close && bitmap.close();

      var blob = await new Promise(function (resolve) {
        canvas.toBlob(resolve, "image/webp", cls.quality);
      });
      if (!blob || blob.type !== "image/webp" || blob.size >= original.byteLength) {
        return { uri: originalUri, before: original.byteLength, after: original.byteLength, recoded: false };
      }
      return {
        uri: await blobToDataUri(blob),
        before: original.byteLength,
        after: blob.size,
        recoded: true,
      };
    } catch (_error) {
      return { uri: originalUri, before: original.byteLength, after: original.byteLength, recoded: false };
    }
  }

  function isRelativeReference(value) {
    return Boolean(value)
      && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{)/i.test(value);
  }

  /** Resolves `../img/a.png` against the entry HTML's own directory. */
  function resolveBundlePath(entryPath, reference) {
    var cleaned = reference.split("?")[0].split("#")[0];
    var base = entryPath.split("/").slice(0, -1);
    var parts = cleaned.split("/");
    var stack = cleaned.charAt(0) === "/" ? [] : base.slice();
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "" || parts[i] === ".") continue;
      if (parts[i] === "..") stack.pop();
      else stack.push(parts[i]);
    }
    return stack.join("/");
  }

  function collectReferences(html, entryPath) {
    var references = new Set();
    var attributePattern = new RegExp("\\s(?:" + ASSET_ATTRIBUTES + ")\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "gi");
    var match;
    while ((match = attributePattern.exec(html)) !== null) {
      var value = match[2] !== undefined ? match[2] : match[3];
      if (isRelativeReference(value) && ASSET_EXTENSIONS.test(value)) references.add(value);
    }
    var urlPattern = /url\(\s*("([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
    while ((match = urlPattern.exec(html)) !== null) {
      var raw = (match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] || "").trim();
      if (isRelativeReference(raw) && ASSET_EXTENSIONS.test(raw)) references.add(raw);
    }
    return Array.from(references).map(function (reference) {
      return { reference: reference, path: resolveBundlePath(entryPath, reference) };
    });
  }

  function replaceReference(html, reference, uri) {
    var escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var attributePattern = new RegExp("(\\s(?:" + ASSET_ATTRIBUTES + ")\\s*=\\s*)(\"" + escaped + "\"|'" + escaped + "')", "gi");
    var next = html.replace(attributePattern, function (_match, prefix) {
      return prefix + '"' + uri + '"';
    });
    var urlPattern = new RegExp("url\\(\\s*(?:\"" + escaped + "\"|'" + escaped + "'|" + escaped + ")\\s*\\)", "gi");
    return next.replace(urlPattern, 'url("' + uri + '")');
  }

  /** Adds the bridge attribute to a CTA that was exported without one. */
  function bakeCtaBridge(html) {
    if (/data-tranzmit-action\s*=\s*["']cta["']/i.test(html)) return html;
    return html.replace(
      /(<button)((?:[^>]*?\sclass="[^"]*\bcta\b[^"]*"[^>]*?))(>)/gi,
      '$1$2 data-tranzmit-action="cta"$3'
    );
  }

  function bakeFlattenCss(html) {
    if (html.indexOf(FLATTEN_MARKER) !== -1) return html;
    if (html.indexOf("</style>") !== -1) {
      var index = html.lastIndexOf("</style>");
      return html.slice(0, index) + "\n" + FLATTEN_CSS + "\n" + html.slice(index);
    }
    if (/<\/head>/i.test(html)) {
      return html.replace(/<\/head>/i, "<style>" + FLATTEN_CSS + "</style></head>");
    }
    return "<style>" + FLATTEN_CSS + "</style>" + html;
  }

  /** Legacy skeletons need the flatten layer; tz-template documents do not. */
  function looksLegacy(html) {
    if (/\btz-template\b/.test(html)) return false;
    return /class=["'][^"']*\b(?:device|screen|paywall-screen)\b/.test(html);
  }

  async function sha256Integrity(text) {
    var bytes = new TextEncoder().encode(text);
    var digest = await crypto.subtle.digest("SHA-256", bytes);
    return "sha256-" + bytesToBase64(digest);
  }

  function parseLocalization(raw) {
    var parsed = JSON.parse(raw);
    if (parsed && parsed.translations) return parsed;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      var locales = Object.keys(parsed);
      if (!locales.length) return null;
      return { defaultLocale: locales.indexOf("en") >= 0 ? "en" : locales[0], translations: parsed };
    }
    return null;
  }

  /**
   * Builds the exact document that would be served, from a dropped folder.
   * Returns the document plus everything the operator needs to see what the
   * build did to their files.
   */
  async function buildBundle(entries, options) {
    options = options || {};
    var byPath = new Map();
    entries.forEach(function (entry) { byPath.set(entry.path, entry.file); });

    var candidates = htmlCandidates(entries);
    if (!candidates.length) throw new Error("No .html file was found in the dropped files.");
    var entryPath = options.entryPath && byPath.has(options.entryPath) ? options.entryPath : candidates[0];

    var html = await readText(byPath.get(entryPath));
    var references = collectReferences(html, entryPath);
    var assets = [];
    var missing = [];

    for (var i = 0; i < references.length; i++) {
      var file = byPath.get(references[i].path);
      if (!file) {
        missing.push(references[i].reference);
        continue;
      }
      var encoded = await encodeAsset(references[i].path, file);
      html = replaceReference(html, references[i].reference, encoded.uri);
      assets.push({
        path: references[i].path,
        before: encoded.before,
        after: encoded.after,
        recoded: encoded.recoded,
      });
    }

    var bakedFlatten = false;
    var shouldFlatten = options.flatten === undefined ? looksLegacy(html) : Boolean(options.flatten);
    if (shouldFlatten) {
      var flattened = bakeFlattenCss(html);
      bakedFlatten = flattened !== html;
      html = flattened;
    }
    var withBridge = bakeCtaBridge(html);
    var bakedBridge = withBridge !== html;
    html = withBridge;

    var localization = null;
    var localizationSource = null;
    var localizationEntry = entries.find(function (entry) {
      return /(^|\/)(translations|localization|locales)\.json$/i.test(entry.path);
    });
    if (localizationEntry) {
      localization = parseLocalization(await readText(localizationEntry.file));
      localizationSource = localizationEntry.path;
    }

    var products = null;
    var productsEntry = entries.find(function (entry) { return /(^|\/)products\.json$/i.test(entry.path); });
    if (productsEntry) {
      var parsedProducts = JSON.parse(await readText(productsEntry.file));
      products = Array.isArray(parsedProducts) ? parsedProducts : (parsedProducts.products || null);
    }

    return {
      entryPath: entryPath,
      candidates: candidates,
      html: html,
      integrity: await sha256Integrity(html),
      bytes: new TextEncoder().encode(html).length,
      assets: assets,
      missingAssets: missing,
      bakedFlatten: bakedFlatten,
      bakedBridge: bakedBridge,
      localization: localization,
      localizationSource: localizationSource,
      products: products,
    };
  }

  // --- Device rendering harness ---------------------------------------------
  //
  // Renders through the SDK's real renderDocument() and runs the same in-frame
  // audit as templates/preview in the SDK repo. Both files are vendored by
  // scripts/vendor-preview-harness.mjs, so the dashboard and the authoring
  // harness enforce one definition of "renders correctly". A raw browser render
  // would miss safe areas, the wrapper CSS, localization, and the real usable
  // height, which is exactly what the harness exists to catch.

  var harnessModules = null;

  async function loadHarness() {
    if (!harnessModules) {
      harnessModules = Promise.all([
        import("/config-dashboard/compose.bundle.js"),
        import("/config-dashboard/responsive.mjs"),
        fetch("/config-dashboard/preview-harness.json", { credentials: "same-origin" })
          .then(function (response) { return response.ok ? response.json() : {}; })
          .catch(function () { return {}; }),
      ]).then(function (loaded) {
        return { compose: loaded[0], responsive: loaded[1], manifest: loaded[2] };
      });
    }
    return harnessModules;
  }

  async function harnessDevices() {
    return (await loadHarness()).responsive.RESPONSIVE_DEVICES;
  }

  async function harnessInfo() {
    var loaded = await loadHarness();
    return {
      sdkVersion: loaded.compose.SDK_VERSION || loaded.manifest.sdkVersion || "unknown",
      devices: loaded.responsive.RESPONSIVE_DEVICES,
      learnings: loaded.responsive.RESPONSIVE_LEARNINGS,
    };
  }

  // Mirrors templates/preview/build-preview.mjs. The usable height of a sheet is
  // not the device height, and composing at the wrong height moves the fold.
  function heightFromPresentation(presentation, height) {
    if (presentation === "inline") return height * 0.72;
    if (presentation === "fullscreen") return height;
    if (presentation === "modal") return height * 0.9;
    return height * 0.86;
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function makeViewport(device, presentation) {
    var height = heightFromPresentation(presentation, device.height);
    return {
      width: device.width,
      height: height,
      safeTop: device.safeTop,
      safeBottom: device.safeBottom,
      safeLeft: device.safeLeft,
      safeRight: device.safeRight,
      pixelRatio: device.dpr,
      scale: clamp(Math.min(device.width / 390, height / 844), 0.82, 1.12),
      presentation: presentation,
    };
  }

  /**
   * Every configured locale, default first. A missing token renders as an empty
   * string in the SDK and can change the layout, so one locale proves nothing
   * about the others.
   */
  function localesFor(spec) {
    var localization = spec && spec.localization;
    var translations = (localization && localization.translations) || {};
    var declared = Object.keys(translations);
    if (!declared.length) return [{ locale: undefined, label: "default" }];
    var defaultLocale = localization.defaultLocale;
    declared.sort(function (left, right) {
      if (left === defaultLocale) return -1;
      if (right === defaultLocale) return 1;
      return left.localeCompare(right);
    });
    return declared.map(function (locale) {
      return { locale: locale, label: locale === defaultLocale ? locale + " · default" : locale };
    });
  }

  function presentationOf(spec) {
    var mode = spec && spec.presentation && spec.presentation.mode;
    return ["sheet", "modal", "fullscreen", "inline"].indexOf(mode) >= 0 ? mode : "sheet";
  }

  /**
   * Composes and measures the spec at every locale and device. Returns one
   * audit per render, in the shape the server's preflight consumes.
   */
  async function auditSpec(spec, frame, onProgress) {
    var loaded = await loadHarness();
    var renderDocument = loaded.compose.renderDocument;
    var injectResponsiveAudit = loaded.responsive.injectResponsiveAudit;
    var devices = loaded.responsive.RESPONSIVE_DEVICES;
    var presentation = presentationOf(spec);
    var locales = localesFor(spec);
    var forbidBackAction = Boolean(spec && spec.metadata && String(spec.metadata.forbidBackAction) === "true");

    var plan = [];
    locales.forEach(function (entry) {
      devices.forEach(function (device) {
        plan.push({ entry: entry, device: device });
      });
    });

    var results = [];
    for (var index = 0; index < plan.length; index++) {
      var step = plan[index];
      if (onProgress) onProgress(step, index, plan.length);
      var localeKey = step.entry.locale || "default";
      var auditId = localeKey + ":" + step.device.id;
      var html;
      try {
        html = renderDocument(
          spec,
          presentation,
          makeViewport(step.device, presentation),
          undefined,
          step.entry.locale
        );
      } catch (error) {
        results.push({
          id: auditId,
          deviceId: step.device.id,
          label: step.device.label,
          locale: localeKey,
          width: step.device.width,
          height: step.device.height,
          passed: false,
          failures: ["compose error: " + (error && error.message ? error.message : String(error))],
        });
        continue;
      }

      var meta = {
        auditId: auditId,
        locale: localeKey,
        viewport: step.device.width + "x" + step.device.height,
        forbidBackAction: forbidBackAction,
        mode: "candidate",
      };
      results.push(await runAudit(injectResponsiveAudit(html, meta), meta, step.device, frame));
    }
    return results;
  }

  function runAudit(html, meta, device, frame) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(result) {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        window.clearTimeout(timer);
        resolve(result);
      }
      function onMessage(event) {
        if (event.source !== frame.contentWindow) return;
        var report = event.data;
        if (!report || report.type !== "tranzmit-responsive-audit" || report.auditId !== meta.auditId) return;
        finish({
          id: meta.auditId,
          deviceId: device.id,
          label: device.label,
          locale: meta.locale,
          width: device.width,
          height: device.height,
          passed: Boolean(report.passed),
          failures: report.failures || [],
          details: report.details || {},
        });
      }

      // An unmeasured render must never read as a passing render.
      var timer = window.setTimeout(function () {
        finish({
          id: meta.auditId,
          deviceId: device.id,
          label: device.label,
          locale: meta.locale,
          width: device.width,
          height: device.height,
          passed: false,
          failures: ["render did not report back within 12s"],
          timedOut: true,
        });
      }, 12000);

      window.addEventListener("message", onMessage);
      // Lay out at the real device size, then scale the whole frame down to fit
      // the on-screen stage. Scaling is visual only — the document still lays
      // out at `device.width`, which is what is being measured.
      frame.width = device.width;
      frame.height = device.height;
      frame.style.width = device.width + "px";
      frame.style.height = device.height + "px";
      var stage = frame.parentElement;
      var scale = stage
        ? Math.min(stage.clientWidth / device.width, stage.clientHeight / device.height)
        : 1;
      frame.style.transform = "scale(" + (scale || 1) + ")";
      frame.srcdoc = html;
    });
  }

  window.TranzmitImport = {
    filesFromInput: filesFromInput,
    filesFromDataTransfer: filesFromDataTransfer,
    buildBundle: buildBundle,
    htmlCandidates: htmlCandidates,
    auditSpec: auditSpec,
    harnessDevices: harnessDevices,
    harnessInfo: harnessInfo,
    localesFor: localesFor,
    looksLegacy: looksLegacy,
    readText: readText,
  };
})();
