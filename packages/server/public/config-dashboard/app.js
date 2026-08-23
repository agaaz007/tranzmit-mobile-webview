(function () {
  "use strict";

  var state = {
    environments: [],
    environment: null,
    section: "paywalls",
    paywalls: [],
    placements: [],
    selectedPaywallId: null,
    paywallDetail: null,
    selectedReleaseId: null,
    selectedPlacementId: null,
    placementHistory: null,
    selectedRevisionId: null,
    dialogAction: null,
  };

  var ids = [
    "environmentSelect", "environmentSummary", "refreshButton", "globalNotice",
    "lockedBanner", "loadingState", "errorState", "errorMessage", "retryButton",
    "workspace", "collectionTitle", "collectionSubtitle", "collectionCount",
    "collectionList", "emptyDetail", "paywallDetail", "placementDetail",
    "paywallName", "paywallKey", "paywallPointer", "promoteButton",
    "savePaywallButton", "previewButton", "documentHtml", "documentCss",
    "documentJs", "documentBaseUrl", "localizationJson", "productsJson",
    "checkoutJson", "contentJson", "previewLocale", "paywallPreview",
    "paywallReleases", "placementTrigger", "placementStatus", "placementPointer",
    "savePlacementButton", "routingStatus", "defaultBinding", "defaultVariantKey",
    "statsigExperimentId", "targetingRulesJson", "variantsJson", "placementRevisions",
    "confirmationDialog", "confirmationForm", "dialogTitle", "dialogSubtitle",
    "diffOutput", "confirmationPhrase", "confirmationText", "confirmActionButton", "toast",
  ];
  var el = {};
  ids.forEach(function (id) { el[id] = document.getElementById(id); });

  var noticeTimer = null;
  var toastTimer = null;

  function ApiError(message, status, details) {
    this.name = "ApiError";
    this.message = message;
    this.status = status;
    this.details = details;
  }
  ApiError.prototype = Object.create(Error.prototype);

  async function request(path, options) {
    var init = Object.assign({ credentials: "same-origin" }, options || {});
    init.headers = Object.assign({ Accept: "application/json" }, init.headers || {});
    if (init.body !== undefined && typeof init.body !== "string") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(init.body);
    }

    var response = await fetch(path, init);
    var raw = await response.text();
    var payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); }
      catch (_error) { payload = { error: raw }; }
    }
    if (!response.ok) {
      throw new ApiError(
        payload && payload.error ? payload.error : "Request failed",
        response.status,
        payload && payload.details
      );
    }
    return payload;
  }

  function show(element, visible) {
    element.classList.toggle("is-hidden", !visible);
  }

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function text(tag, value, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? "" : String(value);
    return node;
  }

  function button(label, className, handler, disabled) {
    var node = document.createElement("button");
    node.type = "button";
    node.className = className || "button button-secondary button-small";
    node.textContent = label;
    node.disabled = Boolean(disabled);
    node.addEventListener("click", handler);
    return node;
  }

  function pretty(value) {
    return JSON.stringify(value == null ? null : value, null, 2);
  }

  function dateLabel(value) {
    if (!value) return "Unknown date";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function environmentLocked() {
    return !state.environment || state.environment.management_status === "legacy_locked";
  }

  function showNotice(message, kind, persistent) {
    if (noticeTimer) window.clearTimeout(noticeTimer);
    el.globalNotice.textContent = message;
    el.globalNotice.classList.remove("notice-hidden", "is-error");
    if (kind === "error") el.globalNotice.classList.add("is-error");
    if (!persistent) {
      noticeTimer = window.setTimeout(function () {
        el.globalNotice.classList.add("notice-hidden");
      }, 7000);
    }
  }

  function showToast(message) {
    if (toastTimer) window.clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(function () {
      el.toast.classList.remove("is-visible");
    }, 3500);
  }

  function setButtonBusy(node, busy, busyLabel) {
    if (!node) return;
    if (busy) {
      node.dataset.originalLabel = node.textContent;
      node.textContent = busyLabel || "Working...";
      node.disabled = true;
    } else {
      node.textContent = node.dataset.originalLabel || node.textContent;
      node.disabled = environmentLocked();
      delete node.dataset.originalLabel;
    }
  }

  async function runMutation(node, work, successMessage) {
    setButtonBusy(node, true);
    try {
      var result = await work();
      if (successMessage) showToast(successMessage);
      return result;
    } catch (error) {
      if (error && error.status === 409) {
        if (el.confirmationDialog.open) el.confirmationDialog.close();
        showNotice("Published configuration changed in another session. The environment has been refreshed; review the new diff before trying again.", "error", true);
        await loadEnvironmentData({ preserveSelection: true });
        return null;
      }
      showNotice(formatError(error), "error", true);
      return null;
    } finally {
      setButtonBusy(node, false);
      applyReadOnlyState();
    }
  }

  function formatError(error) {
    var message = error && error.message ? error.message : String(error || "Unknown error");
    if (error && error.details) message += "\n" + pretty(error.details);
    return message;
  }

  async function loadEnvironments() {
    show(el.loadingState, true);
    show(el.errorState, false);
    show(el.workspace, false);
    try {
      state.environments = await request("/admin/v2/environments");
      renderEnvironmentSelect();
      if (!state.environments.length) {
        throw new Error("No V2 environments are available.");
      }
      var saved = window.localStorage.getItem("tranzmit.dashboard.environment");
      var selected = state.environments.find(function (environment) { return environment.id === saved; });
      state.environment = selected || state.environments[0];
      el.environmentSelect.value = state.environment.id;
      await loadEnvironmentData();
    } catch (error) {
      show(el.loadingState, false);
      show(el.errorState, true);
      el.errorMessage.textContent = formatError(error);
    }
  }

  function renderEnvironmentSelect() {
    clear(el.environmentSelect);
    var grouped = new Map();
    state.environments.forEach(function (environment) {
      var project = environment.project_key || "unassigned";
      if (!grouped.has(project)) grouped.set(project, []);
      grouped.get(project).push(environment);
    });

    Array.from(grouped.keys()).sort().forEach(function (project) {
      var group = document.createElement("optgroup");
      group.label = project;
      grouped.get(project).forEach(function (environment) {
        var option = document.createElement("option");
        option.value = environment.id;
        option.textContent = (environment.environment_kind || "environment") + " - " + (environment.name || environment.public_key);
        group.appendChild(option);
      });
      el.environmentSelect.appendChild(group);
    });
  }

  async function loadEnvironmentData(options) {
    if (!state.environment) return;
    var preserve = options && options.preserveSelection;
    var previousPaywall = preserve ? state.selectedPaywallId : null;
    var previousPlacement = preserve ? state.selectedPlacementId : null;
    show(el.loadingState, true);
    show(el.errorState, false);
    show(el.workspace, false);
    try {
      var key = encodeURIComponent(state.environment.public_key);
      var responses = await Promise.all([
        request("/admin/paywalls?public_key=" + key),
        request("/admin/v2/placements?public_key=" + key),
      ]);
      state.paywalls = responses[0] || [];
      state.placements = responses[1] || [];
      state.selectedPaywallId = state.paywalls.some(function (item) { return item.binding_id === previousPaywall; }) ? previousPaywall : null;
      state.selectedPlacementId = state.placements.some(function (item) { return item.placement_id === previousPlacement; }) ? previousPlacement : null;
      state.paywallDetail = null;
      state.placementHistory = null;
      el.environmentSummary.textContent = state.environment.config_source + " / " + state.environment.sdk_stack;
      show(el.lockedBanner, environmentLocked());
      show(el.loadingState, false);
      show(el.workspace, true);
      renderSection();
      applyReadOnlyState();
      if (state.section === "paywalls" && state.selectedPaywallId) await selectPaywall(state.selectedPaywallId);
      if (state.section === "placements" && state.selectedPlacementId) await selectPlacement(state.selectedPlacementId);
    } catch (error) {
      show(el.loadingState, false);
      show(el.errorState, true);
      el.errorMessage.textContent = formatError(error);
    }
  }

  function renderSection() {
    document.querySelectorAll("[data-section]").forEach(function (tab) {
      tab.classList.toggle("is-active", tab.dataset.section === state.section);
    });
    var paywalls = state.section === "paywalls";
    el.collectionTitle.textContent = paywalls ? "Paywalls" : "Placements";
    el.collectionSubtitle.textContent = paywalls
      ? "Immutable content and environment releases."
      : "Versioned routing and experiment assignments.";
    el.collectionCount.textContent = String(paywalls ? state.paywalls.length : state.placements.length);
    renderCollection();
    show(el.paywallDetail, paywalls && Boolean(state.paywallDetail));
    show(el.placementDetail, !paywalls && Boolean(state.placementHistory));
    show(el.emptyDetail, paywalls ? !state.paywallDetail : !state.placementHistory);
  }

  function renderCollection() {
    clear(el.collectionList);
    var items = state.section === "paywalls" ? state.paywalls : state.placements;
    if (!items.length) {
      el.collectionList.appendChild(text("div", "No items in this environment.", "empty-row"));
      return;
    }

    items.forEach(function (item) {
      var isPaywall = state.section === "paywalls";
      var id = isPaywall ? item.binding_id : item.placement_id;
      var active = isPaywall ? state.selectedPaywallId === id : state.selectedPlacementId === id;
      var node = document.createElement("button");
      node.type = "button";
      node.className = "collection-item" + (active ? " is-active" : "");
      node.appendChild(text("strong", isPaywall ? item.display_name : item.trigger));
      node.appendChild(text("small", isPaywall ? item.paywall_key : (item.statsig_experiment_id || "No experiment")));
      var meta = document.createElement("div");
      meta.className = "collection-item-meta";
      meta.appendChild(text(
        "span",
        isPaywall
          ? (item.current_release_number ? "Release " + item.current_release_number : "Unpublished")
          : (item.current_revision_number ? "Routing " + item.current_revision_number : "Unpublished"),
        "muted"
      ));
      if (!isPaywall && item.status) meta.appendChild(text("span", item.status, "status-tag"));
      node.appendChild(meta);
      node.addEventListener("click", function () {
        if (isPaywall) selectPaywall(id);
        else selectPlacement(id);
      });
      el.collectionList.appendChild(node);
    });
  }

  async function selectPaywall(bindingId, preferredReleaseId) {
    state.selectedPaywallId = bindingId;
    state.paywallDetail = null;
    renderSection();
    show(el.emptyDetail, true);
    el.emptyDetail.firstElementChild.textContent = "Loading paywall";
    el.emptyDetail.children[1].textContent = "Fetching immutable release history.";
    try {
      state.paywallDetail = await request("/admin/paywalls/" + encodeURIComponent(bindingId));
      var releases = state.paywallDetail.releases || [];
      var preferred = releases.find(function (release) { return release.id === preferredReleaseId; });
      var current = releases.find(function (release) { return release.is_current; });
      state.selectedReleaseId = (preferred || current || releases[0] || {}).id || null;
      renderPaywallDetail();
      renderCollection();
      show(el.emptyDetail, false);
      show(el.paywallDetail, true);
    } catch (error) {
      showNotice(formatError(error), "error", true);
      state.selectedPaywallId = null;
      renderSection();
    }
  }

  function renderPaywallDetail() {
    var detail = state.paywallDetail;
    if (!detail) return;
    el.paywallName.textContent = detail.display_name;
    el.paywallKey.textContent = detail.paywall_key;
    var current = (detail.releases || []).find(function (release) { return release.is_current; });
    el.paywallPointer.textContent = current
      ? "Published release " + current.release_number + " / content " + shortHash(current.content_hash)
      : "No release is published.";

    var selected = (detail.releases || []).find(function (release) { return release.id === state.selectedReleaseId; }) || current || detail.releases[0];
    if (selected) hydratePaywallEditor(selected);
    else clearPaywallEditor();
    renderPaywallHistory();
    var canPromote = state.environment.environment_kind === "test" && Boolean(current);
    show(el.promoteButton, canPromote);
    el.promoteButton.title = "Copies only content to the matching live paywall. Live products and checkout stay unchanged.";
    applyReadOnlyState();
  }

  function hydratePaywallEditor(release) {
    state.selectedReleaseId = release.id;
    var content = clone(release.content || {});
    var documentSpec = content.document || {};
    el.documentHtml.value = documentSpec.html || "";
    el.documentCss.value = documentSpec.css || "";
    el.documentJs.value = documentSpec.js || "";
    el.documentBaseUrl.value = documentSpec.baseUrl || "";
    el.localizationJson.value = pretty(content.localization || { defaultLocale: "en", translations: { en: {} } });
    el.productsJson.value = pretty(release.products || []);
    el.checkoutJson.value = pretty(release.checkout == null ? null : release.checkout);
    delete content.document;
    delete content.localization;
    delete content.products;
    delete content.checkout;
    el.contentJson.value = pretty(content);
    updatePreviewLocales();
    renderPreview();
    renderPaywallHistory();
  }

  function clearPaywallEditor() {
    ["documentHtml", "documentCss", "documentJs", "documentBaseUrl", "localizationJson", "productsJson", "checkoutJson", "contentJson"].forEach(function (id) {
      el[id].value = "";
    });
    el.paywallPreview.srcdoc = previewMessage("No release is available to preview.");
  }

  function composeEditorSpec() {
    var content = parseJsonField(el.contentJson, "Other content JSON", {});
    if (!content || Array.isArray(content) || typeof content !== "object") {
      throw new Error("Other content JSON must be an object.");
    }
    delete content.document;
    delete content.localization;
    delete content.products;
    delete content.checkout;

    var localization = parseJsonField(el.localizationJson, "Localization JSON", null);
    var products = parseJsonField(el.productsJson, "Products JSON", []);
    var checkout = parseJsonField(el.checkoutJson, "Checkout JSON", null);
    if (!Array.isArray(products)) throw new Error("Products JSON must be an array.");
    if (localization !== null && (Array.isArray(localization) || typeof localization !== "object")) {
      throw new Error("Localization JSON must be an object or null.");
    }
    if (checkout !== null && (Array.isArray(checkout) || typeof checkout !== "object")) {
      throw new Error("Checkout JSON must be an object or null.");
    }

    var documentSpec = { html: el.documentHtml.value };
    if (el.documentCss.value) documentSpec.css = el.documentCss.value;
    if (el.documentJs.value) documentSpec.js = el.documentJs.value;
    if (el.documentBaseUrl.value.trim()) documentSpec.baseUrl = el.documentBaseUrl.value.trim();
    content.document = documentSpec;
    if (localization !== null) content.localization = localization;
    content.products = products;
    if (checkout !== null) content.checkout = checkout;
    return content;
  }

  function parseJsonField(node, label, fallback) {
    var raw = node.value.trim();
    if (!raw) return clone(fallback);
    try { return JSON.parse(raw); }
    catch (error) { throw new Error(label + " is not valid JSON: " + error.message); }
  }

  function updatePreviewLocales() {
    var previous = el.previewLocale.value;
    clear(el.previewLocale);
    var rawOption = document.createElement("option");
    rawOption.value = "__raw__";
    rawOption.textContent = "Raw tokens";
    el.previewLocale.appendChild(rawOption);
    try {
      var localization = parseJsonField(el.localizationJson, "Localization JSON", null);
      var translations = localization && localization.translations ? localization.translations : {};
      Object.keys(translations).sort().forEach(function (locale) {
        var option = document.createElement("option");
        option.value = locale;
        option.textContent = locale;
        el.previewLocale.appendChild(option);
      });
      var desired = previous || (localization && localization.defaultLocale) || "__raw__";
      el.previewLocale.value = Array.from(el.previewLocale.options).some(function (option) { return option.value === desired; }) ? desired : "__raw__";
    } catch (_error) {
      el.previewLocale.value = "__raw__";
    }
  }

  function renderPreview() {
    try {
      var spec = composeEditorSpec();
      var documentSpec = spec.document || {};
      var html = String(documentSpec.html || "");
      var locale = el.previewLocale.value;
      if (locale && locale !== "__raw__") {
        html = localizeHtml(html, localizedStrings(spec.localization, locale));
      }
      el.paywallPreview.srcdoc = assembleDocument(html, documentSpec.css, documentSpec.js, documentSpec.baseUrl);
    } catch (error) {
      el.paywallPreview.srcdoc = previewMessage(formatError(error));
    }
  }

  function assembleDocument(html, css, js, baseUrl) {
    var base = baseUrl ? '<base href="' + escapeAttribute(baseUrl) + '">' : "";
    var style = css ? "<style>" + css + "</style>" : "";
    var script = js ? "<script>" + js + "<\/script>" : "";
    if (/<html[\s>]/i.test(html)) {
      var full = html;
      if (/<\/head>/i.test(full)) full = full.replace(/<\/head>/i, base + style + "</head>");
      else full = base + style + full;
      if (/<\/body>/i.test(full)) full = full.replace(/<\/body>/i, script + "</body>");
      else full += script;
      return full;
    }
    return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" + base + style + "</head><body>" + html + script + "</body></html>";
  }

  function previewMessage(message) {
    return "<!doctype html><html><body style=\"font:14px system-ui;color:#5f6b75;padding:24px\">" + escapeHtml(message) + "</body></html>";
  }

  function localizedStrings(localization, locale) {
    if (!localization || !localization.translations) return {};
    var translations = localization.translations;
    var base = translations[localization.defaultLocale] || {};
    var language = String(locale || "").split(/[-_]/)[0];
    return Object.assign({}, base, translations[locale] || translations[language] || {});
  }

  function localizeHtml(html, strings) {
    return html.replace(/\{\{\s*(\w+)\s*\}\}/g, function (_match, key) {
      return strings[key] == null ? "" : escapeHtml(String(strings[key]));
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  async function savePaywallCandidate() {
    var spec;
    try { spec = composeEditorSpec(); }
    catch (error) { showNotice(formatError(error), "error", true); return; }
    var result = await runMutation(el.savePaywallButton, function () {
      return request("/admin/paywalls/" + encodeURIComponent(state.selectedPaywallId) + "/releases", {
        method: "POST",
        body: { spec: spec },
      });
    }, "Candidate saved. Review its diff before publishing.");
    if (result) await selectPaywall(state.selectedPaywallId, result.id);
  }

  function renderPaywallHistory() {
    clear(el.paywallReleases);
    var detail = state.paywallDetail;
    if (!detail || !detail.releases || !detail.releases.length) {
      el.paywallReleases.appendChild(text("div", "No releases have been created.", "empty-row"));
      return;
    }
    var current = detail.releases.find(function (release) { return release.is_current; });
    detail.releases.forEach(function (release) {
      var row = document.createElement("div");
      row.className = "history-row";
      var main = document.createElement("div");
      main.className = "history-main";
      var titleLine = document.createElement("div");
      titleLine.className = "title-line";
      titleLine.appendChild(text("strong", "Release " + release.release_number));
      if (release.is_current) titleLine.appendChild(text("span", "Published", "history-tag current"));
      else titleLine.appendChild(text("span", "Candidate", "history-tag candidate"));
      main.appendChild(titleLine);
      main.appendChild(text("small", shortHash(release.content_hash) + " / " + (release.created_by || "unknown")));
      row.appendChild(main);
      row.appendChild(text("div", dateLabel(release.created_at), "history-meta"));
      var actions = document.createElement("div");
      actions.className = "history-actions";
      actions.appendChild(button("Load", "button button-secondary button-small", function () {
        hydratePaywallEditor(release);
      }, false));
      if (!release.is_current) {
        var older = current && Number(release.release_number) < Number(current.release_number);
        actions.appendChild(button(
          older ? "Review rollback" : "Review publish",
          older ? "button button-secondary button-small" : "button button-primary button-small",
          function () { reviewPaywallPointer(release, older ? "rollback" : "publish"); },
          environmentLocked()
        ));
      }
      row.appendChild(actions);
      el.paywallReleases.appendChild(row);
    });
  }

  async function reviewPaywallPointer(release, action) {
    try {
      var diff = await request(
        "/admin/paywalls/" + encodeURIComponent(state.selectedPaywallId) +
        "/releases/" + encodeURIComponent(release.id) + "/diff"
      );
      var review = buildPaywallReview(diff, release);
      var phrase = state.paywallDetail.paywall_key;
      openConfirmation({
        title: action === "rollback" ? "Review paywall rollback" : "Review paywall publish",
        subtitle: "This changes one environment pointer. A stale pointer will be rejected.",
        phrase: phrase,
        confirmLabel: action === "rollback" ? "Rollback" : "Publish",
        diff: review,
        action: function () {
          var base = "/admin/paywalls/" + encodeURIComponent(state.selectedPaywallId);
          var currentId = state.paywallDetail.current_release_id || null;
          if (action === "rollback") {
            return request(base + "/rollback", {
              method: "POST",
              body: { targetReleaseId: release.id, expectedCurrentReleaseId: currentId },
            });
          }
          return request(base + "/releases/" + encodeURIComponent(release.id) + "/publish", {
            method: "POST",
            body: { expectedCurrentReleaseId: currentId },
          });
        },
        after: async function () {
          await loadEnvironmentData({ preserveSelection: true });
          showToast(action === "rollback" ? "Paywall rolled back." : "Paywall published.");
        },
      });
    } catch (error) {
      showNotice(formatError(error), "error", true);
    }
  }

  function buildPaywallReview(diff, release) {
    var content = release.content || {};
    return {
      pointer_diff: diff,
      exact_candidate_document: content.document || null,
      candidate_document_hash: release.document_hash || (diff.candidate && diff.candidate.document_hash) || null,
      localization_coverage: localizationCoverage(content),
      environment_products: release.products || [],
      environment_checkout: release.checkout == null ? null : release.checkout,
      affected_variants: diff.affected_variants || [],
    };
  }

  function localizationCoverage(content) {
    var html = content && content.document && content.document.html || "";
    var localization = content && content.localization || null;
    var tokens = [];
    var seen = {};
    html.replace(/\{\{\s*(\w+)\s*\}\}/g, function (_match, key) {
      if (!seen[key]) {
        tokens.push(key);
        seen[key] = true;
      }
      return _match;
    });
    tokens.sort();
    var translations = localization && localization.translations || {};
    var locales = {};
    Object.keys(translations).sort().forEach(function (locale) {
      locales[locale] = {
        missing: tokens.filter(function (key) { return translations[locale][key] == null; }),
      };
    });
    return {
      default_locale: localization && localization.defaultLocale || null,
      default_locale_exists: Boolean(localization && translations[localization.defaultLocale]),
      tokens: tokens,
      locales: locales,
      complete: Boolean(
        (!tokens.length || localization) &&
        (!localization || translations[localization.defaultLocale]) &&
        Object.keys(locales).every(function (locale) { return locales[locale].missing.length === 0; })
      ),
    };
  }

  async function promoteToLive() {
    var source = (state.paywallDetail.releases || []).find(function (release) {
      return release.id === state.selectedReleaseId;
    });
    if (!source) {
      showNotice("Select a test release before creating the live candidate.", "error", true);
      return;
    }
    var live = state.environments.find(function (environment) {
      return environment.project_key === state.environment.project_key && environment.environment_kind === "live";
    });
    if (!live) {
      showNotice("This project has no live environment.", "error", true);
      return;
    }
    if (live.management_status === "legacy_locked") {
      showNotice("The matching live environment is read-only.", "error", true);
      return;
    }

    var result = await runMutation(el.promoteButton, async function () {
      var targets = await request("/admin/paywalls?public_key=" + encodeURIComponent(live.public_key));
      var target = targets.find(function (paywall) {
        return paywall.paywall_id === state.paywallDetail.paywall_id || paywall.paywall_key === state.paywallDetail.paywall_key;
      });
      if (!target) throw new Error("The matching live paywall binding was not found.");
      var candidate = await request("/admin/paywalls/" + encodeURIComponent(target.binding_id) + "/promote", {
        method: "POST",
        body: { sourceReleaseId: source.id },
      });
      return { target: target, candidate: candidate };
    }, "Live candidate created. Live billing fields were preserved.");
    if (!result) return;
    state.environment = live;
    el.environmentSelect.value = live.id;
    window.localStorage.setItem("tranzmit.dashboard.environment", live.id);
    state.section = "paywalls";
    await loadEnvironmentData();
    await selectPaywall(result.target.binding_id, result.candidate.id);
    showNotice("Live candidate created from test content. Review the live products, checkout, and diff before publishing.", "info", true);
  }

  async function selectPlacement(placementId, preferredRevisionId) {
    state.selectedPlacementId = placementId;
    state.placementHistory = null;
    renderSection();
    show(el.emptyDetail, true);
    el.emptyDetail.firstElementChild.textContent = "Loading placement";
    el.emptyDetail.children[1].textContent = "Fetching immutable routing history.";
    try {
      state.placementHistory = await request("/admin/placements/" + encodeURIComponent(placementId) + "/revisions");
      var revisions = state.placementHistory.revisions || [];
      var preferred = revisions.find(function (revision) { return revision.id === preferredRevisionId; });
      var current = revisions.find(function (revision) { return revision.is_current; });
      state.selectedRevisionId = (preferred || current || revisions[0] || {}).id || null;
      renderPlacementDetail();
      renderCollection();
      show(el.emptyDetail, false);
      show(el.placementDetail, true);
    } catch (error) {
      showNotice(formatError(error), "error", true);
      state.selectedPlacementId = null;
      renderSection();
    }
  }

  function renderPlacementDetail() {
    var placement = state.placements.find(function (item) { return item.placement_id === state.selectedPlacementId; });
    if (!placement || !state.placementHistory) return;
    el.placementTrigger.textContent = placement.trigger;
    el.placementStatus.textContent = placement.status || "unpublished";
    el.placementPointer.textContent = placement.current_revision_number
      ? "Published routing revision " + placement.current_revision_number
      : "No routing revision is published.";
    populateBindingSelect();
    var selected = (state.placementHistory.revisions || []).find(function (revision) {
      return revision.id === state.selectedRevisionId;
    }) || (state.placementHistory.revisions || [])[0];
    if (selected) hydratePlacementEditor(selected);
    else clearPlacementEditor();
    renderPlacementHistory();
    applyReadOnlyState();
  }

  function populateBindingSelect() {
    var selected = el.defaultBinding.value;
    clear(el.defaultBinding);
    state.paywalls.forEach(function (paywall) {
      var option = document.createElement("option");
      option.value = paywall.binding_id;
      option.textContent = paywall.display_name + " (" + paywall.paywall_key + ")";
      el.defaultBinding.appendChild(option);
    });
    if (selected) el.defaultBinding.value = selected;
  }

  function hydratePlacementEditor(revision) {
    state.selectedRevisionId = revision.id;
    el.routingStatus.value = revision.status || "active";
    el.defaultBinding.value = revision.default_binding_id || "";
    el.defaultVariantKey.value = revision.default_variant_key || "";
    el.statsigExperimentId.value = revision.statsig_experiment_id || "";
    el.targetingRulesJson.value = pretty(revision.targeting_rules || []);
    el.variantsJson.value = pretty((revision.variants || []).map(function (variant) {
      return {
        variantKey: variant.variant_key || variant.variantKey,
        bindingId: variant.binding_id || variant.bindingId,
        status: variant.status || "active",
        weight: Number(variant.weight) || 0,
        fallbackRank: Number(variant.fallback_rank == null ? variant.fallbackRank : variant.fallback_rank) || 0,
      };
    }));
    renderPlacementHistory();
  }

  function clearPlacementEditor() {
    el.routingStatus.value = "paused";
    el.defaultBinding.value = state.paywalls[0] ? state.paywalls[0].binding_id : "";
    el.defaultVariantKey.value = "default";
    el.statsigExperimentId.value = "";
    el.targetingRulesJson.value = "[]";
    el.variantsJson.value = "[]";
  }

  function composeRoutingCandidate() {
    var targetingRules = parseJsonField(el.targetingRulesJson, "Targeting rules JSON", []);
    var variants = parseJsonField(el.variantsJson, "Variants JSON", []);
    if (!Array.isArray(targetingRules)) throw new Error("Targeting rules JSON must be an array.");
    if (!Array.isArray(variants)) throw new Error("Variants JSON must be an array.");
    return {
      status: el.routingStatus.value,
      defaultBindingId: el.defaultBinding.value,
      defaultVariantKey: el.defaultVariantKey.value.trim(),
      statsigExperimentId: el.statsigExperimentId.value.trim() || null,
      targetingRules: targetingRules,
      variants: variants,
    };
  }

  async function savePlacementCandidate() {
    var candidate;
    try { candidate = composeRoutingCandidate(); }
    catch (error) { showNotice(formatError(error), "error", true); return; }
    var result = await runMutation(el.savePlacementButton, function () {
      return request("/admin/placements/" + encodeURIComponent(state.selectedPlacementId) + "/revisions", {
        method: "POST",
        body: candidate,
      });
    }, "Routing candidate saved. Review its diff before publishing.");
    if (result) await selectPlacement(state.selectedPlacementId, result.id);
  }

  function renderPlacementHistory() {
    clear(el.placementRevisions);
    var revisions = state.placementHistory && state.placementHistory.revisions || [];
    if (!revisions.length) {
      el.placementRevisions.appendChild(text("div", "No routing revisions have been created.", "empty-row"));
      return;
    }
    var current = revisions.find(function (revision) { return revision.is_current; });
    revisions.forEach(function (revision) {
      var row = document.createElement("div");
      row.className = "history-row";
      var main = document.createElement("div");
      main.className = "history-main";
      var titleLine = document.createElement("div");
      titleLine.className = "title-line";
      titleLine.appendChild(text("strong", "Routing " + revision.revision_number));
      if (revision.is_current) titleLine.appendChild(text("span", "Published", "history-tag current"));
      else titleLine.appendChild(text("span", "Candidate", "history-tag candidate"));
      main.appendChild(titleLine);
      main.appendChild(text("small", (revision.status || "unknown") + " / " + (revision.created_by || "unknown")));
      row.appendChild(main);
      row.appendChild(text("div", dateLabel(revision.created_at), "history-meta"));
      var actions = document.createElement("div");
      actions.className = "history-actions";
      actions.appendChild(button("Load", "button button-secondary button-small", function () {
        hydratePlacementEditor(revision);
      }, false));
      if (!revision.is_current) {
        var older = current && Number(revision.revision_number) < Number(current.revision_number);
        actions.appendChild(button(
          older ? "Review rollback" : "Review publish",
          older ? "button button-secondary button-small" : "button button-primary button-small",
          function () { reviewPlacementPointer(revision, older ? "rollback" : "publish"); },
          environmentLocked()
        ));
      }
      row.appendChild(actions);
      el.placementRevisions.appendChild(row);
    });
  }

  async function reviewPlacementPointer(revision, action) {
    var placement = state.placements.find(function (item) { return item.placement_id === state.selectedPlacementId; });
    try {
      var diff = await request(
        "/admin/placements/" + encodeURIComponent(state.selectedPlacementId) +
        "/revisions/" + encodeURIComponent(revision.id) + "/diff"
      );
      openConfirmation({
        title: action === "rollback" ? "Review routing rollback" : "Review routing publish",
        subtitle: "This changes one placement pointer. Paywall content pointers are unchanged.",
        phrase: placement.trigger,
        confirmLabel: action === "rollback" ? "Rollback" : "Publish",
        diff: diff,
        action: function () {
          var base = "/admin/placements/" + encodeURIComponent(state.selectedPlacementId);
          var expected = placement.current_revision_id || null;
          if (action === "rollback") {
            return request(base + "/rollback", {
              method: "POST",
              body: { targetRevisionId: revision.id, expectedCurrentRevisionId: expected },
            });
          }
          return request(base + "/revisions/" + encodeURIComponent(revision.id) + "/publish", {
            method: "POST",
            body: { expectedCurrentRevisionId: expected },
          });
        },
        after: async function () {
          await loadEnvironmentData({ preserveSelection: true });
          showToast(action === "rollback" ? "Routing rolled back." : "Routing published.");
        },
      });
    } catch (error) {
      showNotice(formatError(error), "error", true);
    }
  }

  function openConfirmation(options) {
    state.dialogAction = options;
    el.dialogTitle.textContent = options.title;
    el.dialogSubtitle.textContent = options.subtitle;
    el.diffOutput.textContent = pretty(options.diff);
    el.confirmationPhrase.textContent = options.phrase;
    el.confirmationText.value = "";
    el.confirmActionButton.textContent = options.confirmLabel;
    el.confirmActionButton.disabled = true;
    el.confirmationDialog.showModal();
    window.setTimeout(function () { el.confirmationText.focus(); }, 0);
  }

  async function confirmDialogAction() {
    var options = state.dialogAction;
    if (!options || el.confirmationText.value !== options.phrase) return;
    var result = await runMutation(el.confirmActionButton, options.action);
    if (!result) return;
    el.confirmationDialog.close();
    state.dialogAction = null;
    await options.after(result);
  }

  function applyReadOnlyState() {
    var locked = environmentLocked();
    [el.savePaywallButton, el.savePlacementButton, el.promoteButton].forEach(function (node) {
      if (node) node.disabled = locked;
    });
    var editorIds = [
      "documentHtml", "documentCss", "documentJs", "documentBaseUrl", "localizationJson",
      "productsJson", "checkoutJson", "contentJson", "routingStatus", "defaultBinding",
      "defaultVariantKey", "statsigExperimentId", "targetingRulesJson", "variantsJson",
    ];
    editorIds.forEach(function (id) {
      var node = el[id];
      if (node.tagName === "SELECT") node.disabled = locked;
      else node.readOnly = locked;
    });
    document.querySelectorAll(".history-actions button:not(:first-child)").forEach(function (node) {
      node.disabled = locked;
    });
  }

  function shortHash(value) {
    return value ? String(value).slice(0, 12) : "no hash";
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  document.querySelectorAll("[data-section]").forEach(function (tab) {
    tab.addEventListener("click", function () {
      state.section = tab.dataset.section;
      renderSection();
    });
  });

  el.environmentSelect.addEventListener("change", async function () {
    state.environment = state.environments.find(function (environment) {
      return environment.id === el.environmentSelect.value;
    }) || null;
    if (!state.environment) return;
    window.localStorage.setItem("tranzmit.dashboard.environment", state.environment.id);
    state.selectedPaywallId = null;
    state.selectedPlacementId = null;
    await loadEnvironmentData();
  });

  el.refreshButton.addEventListener("click", function () {
    loadEnvironmentData({ preserveSelection: true });
  });
  el.retryButton.addEventListener("click", loadEnvironments);
  el.previewButton.addEventListener("click", function () {
    updatePreviewLocales();
    renderPreview();
  });
  el.previewLocale.addEventListener("change", renderPreview);
  el.localizationJson.addEventListener("change", updatePreviewLocales);
  el.savePaywallButton.addEventListener("click", savePaywallCandidate);
  el.promoteButton.addEventListener("click", promoteToLive);
  el.savePlacementButton.addEventListener("click", savePlacementCandidate);
  el.confirmationText.addEventListener("input", function () {
    el.confirmActionButton.disabled = !state.dialogAction || el.confirmationText.value !== state.dialogAction.phrase;
  });
  el.confirmationForm.addEventListener("submit", function (event) {
    event.preventDefault();
    if (event.submitter && event.submitter.value === "confirm") confirmDialogAction();
    else {
      el.confirmationDialog.close();
      state.dialogAction = null;
    }
  });

  loadEnvironments();
})();
