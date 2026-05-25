# TODOS

## Deferred from v1 milestone

### Optimization Loop (AI Variant Generation)
**Priority:** Critical (core product differentiator)
**What:** Build the AI optimization loop that reads experiment outcomes, generates new structured paywall specs via LLM, validates them against the PaywallSpec schema, and promotes winners into Statsig as new experiment arms.
**Why:** Without this, Tranzmit is "remote config for paywalls" (commoditized). With it, it's "automatic paywall optimization" (unique). This is THE product per the PRD.
**Depends on:** Server operational (T3), events flowing (T6), Statsig experiments running.
**Approach:** Loop reads aggregated conversion/dismissal events, calls LLM with current best-performing spec + metrics, generates N candidate specs, validates schema, creates Statsig experiment arms, monitors for statistical significance, promotes winner.

### Dashboard UI
**Priority:** High (customer-facing)
**What:** Build a web dashboard for managing placements, viewing experiment metrics, and controlling the optimization loop.
**Why:** Customers cannot manage config via SQL. Dashboard is the control plane.
**Depends on:** Server operational, optimization loop running, real experiment data flowing.
**Scope:** Per PRD: "a loop observatory and experiment control center, NOT a visual page builder." Core views: active experiments, conversion metrics, promoted/rejected variants, placement performance, loop decisions/history.

### iOS and Android SDKs
**Priority:** Medium (market expansion)
**What:** Build iOS SDK (Swift) and Android SDK (Kotlin) that consume the same config API and render structured specs natively.
**Why:** PRD positions Tranzmit as cross-platform. Web-only limits addressable market to ~40% of mobile-first companies.
**Depends on:** Server operational (T3), validated spec format from web SDK usage, stable config API contract.
**Approach:** iOS: WKWebView or SwiftUI renderer consuming PaywallSpec. Android: WebView or Jetpack Compose. Both use same GET /config endpoint. Same event batching pattern ported to platform-native networking.
