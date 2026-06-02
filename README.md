# Tranzmit Mobile WebView Paywalls

Cross-platform monetization SDK for Superwall-style, server-driven mobile WebView paywalls. The SDK owns presentation, bridge events, local/offline caching, and analytics. Your Tranzmit server owns placement config, variants, hosted HTML/CSS documents, and dashboard edits.

## Customer Integration Contract

**Tranzmit does not process purchases.** Tranzmit shows the paywall and tells your app which product the customer tapped. Your app must start StoreKit, Google Play Billing, RevenueCat, Stripe, or your own checkout, then call `reportConversion()`.

```tsx
const { gate, reportConversion } = useTranzmit();

gate("upgrade_pro", {
  onCTA: async (product) => {
    await startNativePurchase(product.id); // Your app owns this.
    reportConversion({
      trigger: "upgrade_pro",
      productId: product.id,
      revenue: 9.99,
      currency: "USD",
    });
  },
});
```

If you skip `onCTA`, the button tap is tracked but no purchase starts. This is intentional so customers keep full control of entitlements, refunds, restore purchases, and subscription providers.

## Remote Update Model

- Dashboard saves rebuild each paywall into a WebView document. The server derives `revision` and `cacheKey` from document content, so any HTML/CSS/JS change creates a new hosted document URL instead of reusing Android/iOS cached content.
- Saving a spec also propagates it to any live placements and A/B variants that reference that spec.
- `/v1/config` returns placement assignments and document metadata.
- Hosted document payloads are served from `/v1/paywall-documents/...` with long-lived immutable cache headers.
- Mobile SDKs hydrate hosted documents, store them inside the TTL-aware config cache, and can render the last cached document offline.
- `CONFIG_TTL_SECONDS` defaults to 60 seconds. During QA, call `refreshConfig()` after saving in the dashboard to see changes immediately.
- Existing legacy/native specs are normalized server-side into WebView documents, so production does not depend on app-side legacy rendering.

## Server-Driven Presentation

Set `presentation.mode` in the paywall spec to control how SDKs display the same hosted document:

```json
{
  "presentation": { "mode": "sheet" }
}
```

Supported values are `sheet` (bottom popup), `modal` (centered popup), `fullscreen`, and `inline`. If app code passes an explicit presentation mode to `gate()` / `presentPlacement()`, that local override wins; otherwise the SDK uses the server value and falls back to `sheet`.

## Responsive WebView Contract

The native SDK owns paywall geometry. For `fullscreen`, `sheet`, and `modal`, the native wrapper chooses the exact container size and the WebView fills that frame. The document receives a viewport contract with container width/height, safe-area insets, pixel ratio, scale, and presentation mode through `window.Tranzmit.viewport`, `window.TranzmitNativeViewport`, and CSS variables like `--tz-vh`, `--tz-safe-bottom`, `--tz-container-width`, and `--tz-scale`.

Server templates consume those variables instead of raw `100vh`/`100svh`, and seeded paywalls include a `design` artboard with breakpoints for `360x740`, `390x844`, `412x915`, and tablet frames. Presentation mode is also passed into the document as `tz-presentation-sheet`, `tz-presentation-modal`, `tz-presentation-fullscreen`, or `tz-presentation-inline` on `<html>` and `<body>`.

For visual regression capture on Android, run `npm run test:visual:android` with an emulator open. It captures paywall screenshots at the core breakpoint sizes into `artifacts/paywall-screenshots`.

## How It Works

```
1. init() → fetches config + hosted WebView documents, then caches them locally
2. Subsequent launches → instant render from cache, background refresh
3. gate("trigger_name") / presentPlacement("trigger_name") → shows the WebView paywall
4. CTA bridge event → your app starts the purchase and reports conversion
```

## When Do Paywalls Fire?

**Paywalls only fire when YOU call `gate()`**. The SDK never shows anything automatically.

You decide when to gate. Common patterns:

| Trigger Point | When to Call `gate()` | Example |
|---|---|---|
| Feature gate | User clicks a premium feature | `gate("export_pdf")` before allowing export |
| Onboarding | After signup, before first use | `gate("onboarding")` on the welcome screen |
| Usage limit | User hits a free-tier cap | `gate("upload_limit")` when uploads >= 5 |
| Upgrade prompt | User visits billing/settings | `gate("upgrade_pro")` on the pricing section |
| Time-based | After N days on free plan | `gate("trial_expired")` when trial ends |
| Content gate | User tries to read premium content | `gate("premium_content")` before revealing |

The `trigger` string is just a key that maps to a placement you configured in the dashboard. If the trigger doesn't exist or is disabled server-side, `gate()` returns `{ shown: false }` and does nothing.

## Integration

### Vanilla JS (works with any webapp)

```html
<script src="https://tranzmit-api-production.up.railway.app/sdk/v1.0.0/tranzmit.js"></script>
<script>
  // Call once at app startup
  Tranzmit.init({
    publicKey: "pk_live_xxx",
    userId: user && user.id, // optional until login; omit rather than passing a placeholder
    identifiers: {
      accountID: account && account.id,
      companyID: company && company.id
    },
    userTraits: {
      plan: user && user.plan
    },
    apiBaseUrl: "https://tranzmit-api-production.up.railway.app"
  });

  // Gate a feature — call this wherever you want to show a paywall
  document.getElementById("export-btn").addEventListener("click", () => {
    const result = Tranzmit.gate("export_pdf", {
      onCTA: (product) => {
        // User clicked "Subscribe" — your app starts checkout
        window.location.href = `/checkout?plan=${product.id}`;
      },
      onDismiss: () => {
        // User closed the paywall
      }
    });

    if (!result.shown) {
      // No paywall configured for this trigger, or user already has access
      doExport();
    }
  });
</script>
```

### React

```tsx
import { TranzmitProvider, TranzmitPaywall } from "@tranzmit/react";

function App() {
  return (
    <TranzmitProvider publicKey="pk_live_xxx" userId={user?.id} apiBaseUrl="https://your-tranzmit-api.example.com">
      <ExportButton />
    </TranzmitProvider>
  );
}

function ExportButton() {
  const { gate, isReady } = useTranzmit();

  const handleExport = () => {
    if (!isReady) return;
    const result = gate("export_pdf", {
      onCTA: (product) => startCheckout(product),
    });
    if (!result.shown) doExport();
  };

  return <button onClick={handleExport}>Export PDF</button>;
}
```

### React Native

Install `@tranzmit/react-native` plus `@react-native-async-storage/async-storage` and `react-native-webview`.

```tsx
import { TranzmitProvider, useTranzmit } from "@tranzmit/react-native";

function App() {
  const { user } = useAuth(); // null before login

  return (
    <TranzmitProvider
      publicKey="pk_live_xxx"
      userId={user?.id}
      apiBaseUrl="https://your-tranzmit-api.example.com"
      onError={(err) => console.error("[Tranzmit]", err)}
    >
      <Screens />
    </TranzmitProvider>
  );
}

function UpgradeButton() {
  const { gate } = useTranzmit();

  function openExistingPaywall() {
    // Route to your current native/in-app paywall.
  }

  return (
    <Button
      title="Upgrade"
      onPress={() => {
        const result = gate("upgrade_pro", {
          onCTA: (product) => startNativePurchase(product.id),
          onFallback: ({ reason }) => {
            console.warn("[Tranzmit] falling back to existing paywall", reason);
            openExistingPaywall();
          },
        });
        if (!result.shown) return; // onFallback already routed to the existing paywall.
      }}
    />
  );
}
```

See `examples/expo-react-native/` for a runnable Expo testbed.

### SPA Frameworks (Next.js, Nuxt, SvelteKit, etc.)

```js
// Call init() once in your app's entry point / layout
await Tranzmit.init({ publicKey: "pk_live_xxx", userId: user.id });

// Call gate() on route guards, button clicks, or component mounts
// Works the same everywhere — it's just DOM manipulation
```

## API Reference

### `init(config)`

| Param | Type | Required | Description |
|---|---|---|---|
| `publicKey` | string | yes | Your public key (`pk_live_xxx` or `pk_test_xxx`) |
| `userId` | string | no | Customer app's authenticated user ID. Use this as the default experiment unit for logged-in products. Do not generate random production user IDs. |
| `identifiers` | object | no | Extra stable IDs for advanced experiment units (`accountID`, `companyID`, etc.). The SDK automatically adds a browser `stableID` fallback. |
| `userTraits` | object | no | Traits for targeting (plan, signup_date, etc.) |
| `privateTraits` | object | no | Traits used for targeting but not stored in Tranzmit event rows |
| `apiBaseUrl` | string | no | **Required** when your Tranzmit server is not the default `https://tranzmit-api-production.up.railway.app` host. Each client/project gets its own API URL and public key pair. |
| `onError` | function | no | Error callback |

### What the SDK Calls For You

Customers integrate with **`init()` / `TranzmitProvider` only**. They do **not** manually call hosted document URLs.

On init, the SDK automatically:

1. `POST /v1/config` — fetch placements, variant assignment, and document metadata
2. `GET /v1/paywall-documents/...` — hydrate hosted HTML/CSS when the server uses hosted document delivery
3. Cache the result locally for offline render + background refresh

Later, `gate()` renders the cached document. `track()`, impressions, dismissals, CTA clicks, and `reportConversion()` go to `POST /v1/events` automatically.

After dashboard edits during QA, call `refreshConfig()` to repeat steps 1–2.

### Fallback to an Existing Paywall

Use `options.onFallback` to route customers back to your current in-app paywall if Tranzmit cannot show one. This prevents monetization dead ends when config is unavailable, the trigger is missing/disabled, or the WebView renderer fails.

```tsx
function showUpgradePaywall() {
  const result = gate("upgrade_pro", {
    onCTA: (product) => startNativePurchase(product.id),
    onFallback: ({ reason, error }) => {
      console.warn("[Tranzmit] fallback", reason, error);
      openExistingInAppPaywall();
    },
  });

  if (!result.shown) {
    return; // onFallback already ran for not_ready / placement_not_found.
  }
}
```

Fallback reasons:

| Reason | When it fires |
|---|---|
| `not_ready` | The SDK has not loaded a valid config yet |
| `placement_not_found` | The trigger has no enabled placement in config |
| `render_error` | The React Native WebView reports a render/load failure after showing begins |

### Identity and Experiment Bucketing

`userId` is **optional**. Pass it only when you have a real authenticated user id from your auth system. Do **not** pass placeholder ids such as `"guest"`, `"0"`, or a random uuid at app startup.

When `userId` is omitted, the SDK still initializes using a persisted device-level **`stableID`** (AsyncStorage on React Native, `localStorage` on web). That is enough for config fetch, paywall render, and anonymous experiment assignment.

When `userId` is provided later, `TranzmitProvider` **re-initializes automatically** because `userId` is in its init dependency list. Expect a brief `isReady === false` window while config re-fetches for the logged-in identity.

#### Pattern A — Mount provider at app root (recommended)

Use when paywalls may appear before login, or when you want config pre-cached at launch.

```tsx
<TranzmitProvider userId={user?.id} publicKey="pk_live_xxx" apiBaseUrl="https://your-api.example.com">
  {children}
</TranzmitProvider>
```

- Before login: `user?.id` is `undefined`, SDK uses `stableID`
- After login: same provider, now with real `userId`; SDK re-inits
- On logout: pass `undefined` again (or unmount the provider)

#### Pattern B — Mount provider only after login

Use when paywalls are login-only and you do not want any anonymous Tranzmit session.

```tsx
if (!user) return <LoginFlow />;

return (
  <TranzmitProvider userId={user.id} publicKey="pk_live_xxx" apiBaseUrl="https://your-api.example.com">
    {children}
  </TranzmitProvider>
);
```

Both patterns are supported by the current SDK. Choose based on whether anonymous users should ever see a paywall.

The SDK stores stable IDs under `tranzmit:stable_id:<publicKey>`. Customers do not need a Statsig SDK or Statsig key.

Server-side, Tranzmit maps identity into Statsig as:

```js
{
  userID: "<customer userId>",
  customIDs: {
    stableID: "<tranzmit generated stable id>",
    tranzmitUserID: "<customer userId>",
    accountID: "<optional account id>",
    companyID: "<optional company id>"
  }
}
```

Use Statsig `User ID` as the default randomization unit for logged-in products. That keeps the same logged-in user in the same variant across devices as long as the client passes the same `userId`. Use `stableID` only when you intentionally want anonymous/device-level assignment.

#### Testing variants without affecting production traffic

There is no SDK `forceVariant` flag today. To QA a specific arm:

1. In Statsig Console, add a **user override** for your test `userId`
2. In the app, call `await refreshConfig()` then `gate("your_trigger")`
3. Or temporarily disable other variants in the config dashboard and leave one arm active

Use a dedicated QA `userId` rather than random ids so overrides stay stable.

### `gate(trigger, options)`

| Param | Type | Description |
|---|---|---|
| `trigger` | string | Exact match to a placement trigger in the dashboard |
| `options.onCTA` | `(product) => void` | Fires when user clicks a product/subscribe button |
| `options.onDismiss` | `() => void` | Fires when user closes the paywall |
| `options.onFallback` | `({ trigger, reason, error, variantId }) => void` | Fires when the SDK cannot safely show the Tranzmit paywall, so the app can open its existing paywall |
| `options.onImpression` | `() => void` | Fires when paywall is displayed |
| `options.container` | HTMLElement | Mount to a specific element (default: document.body) |

**Returns:** `{ shown: boolean, variantId?: string, dismiss: () => void }`

### `track(event, properties)`

Log custom analytics events.

### `reportConversion(data)`

Report successful purchase/conversion.

## Compatibility

Works with any webapp that runs JavaScript in a browser:

- Static sites, WordPress, Webflow
- React, Vue, Svelte, Angular, Solid
- React Native
- Flutter
- Swift/iOS client setup generation from the mobile config dashboard

This repo owns the mobile SDKs and the mobile config dashboard. The legacy web SDK and basic `/dashboard` remain in `agaaz007/i-want-to-build-this-sdkf`.

## Architecture

| Package | Description |
|---|---|
| `@tranzmit/shared` | Shared TypeScript types |
| `@tranzmit/core` | Vanilla JS SDK (config, events, renderer) |
| `@tranzmit/react-native` | React Native SDK (Provider, paywall rendering, hooks) |
| `@tranzmit/server` | Mobile config service + event ingestion (Node.js + Postgres) |

The Flutter SDK now lives in the standalone [`tranzmit-flutter-sdk`](https://github.com/agaaz007/tranzmit-flutter-sdk) repository.

## Server

Requires Postgres, an admin secret, and optionally Statsig:

```bash
DATABASE_URL=postgresql://... ADMIN_SECRET=... STATSIG_SERVER_SECRET=secret-xxx npm run dev:server
```

### Endpoints

- `POST /v1/config` - Returns placements, specs, variant assignments from a private identity payload
- `GET /v1/paywall-documents/:placement/:variant/:cacheKey.json` - Hosted WebView document payloads for CDN/edge caching and SDK offline hydration
- `GET /config?key=pk_xxx&userId=u_xxx` - Legacy config endpoint
- `POST /events` - Receives batched analytics events
- `GET /config-dashboard` - Mobile admin console for clients, paywalls, placement slots, and events
- `GET /health` - Health check with DB and Statsig booleans

## Development

```bash
npm install
npm test          # unit + stress + compatibility tests
npm run migrate   # apply Postgres migrations
npm run dev:server
```

## Pre-Ship Validation

Use the local sandbox to exercise the real SDK against either local or production APIs:

```bash
npm run testbed
# open http://127.0.0.1:4174/sandbox
```

The sandbox lets you:

- switch between anonymous and logged-in identities
- set `stableID`, `accountID`, and `companyID`
- pass `userTraits` and `privateTraits`
- load the live placement config for a specific public key
- open each trigger on demand, fire custom events, and report conversions

Use the API smoke test to verify config fetch, event ingestion, and recent-event visibility from the admin API:

```bash
npm run smoke:sdk -- \
  --base https://tranzmit-api-production.up.railway.app \
  --secret "$ADMIN_SECRET" \
  --public-key pk_test_xxx
```

The smoke test exits non-zero if it cannot:

- fetch placements from `POST /v1/config`
- ingest an event with `POST /v1/events`
- find that event in `GET /admin/events/recent`

### Tracking Validation

Before shipping, verify all of the following:

- `impression`, `dismissal`, `cta_click`, and `conversion` appear in the dashboard Events tab
- recent events show the expected `trigger`, `variantId`, `public_key`, `session_id`, and identity payload
- a conversion event uses the same identity family as the paywall exposure that preceded it

### Experiment Validation

For a standard Statsig experiment:

1. Create a Statsig experiment whose parameter payload includes a `variant_id` matching a Tranzmit placement arm.
2. Put the Statsig experiment name into the placement's `Statsig Experiment ID` field.
3. Set the randomization unit to `User ID` for logged-in product tests unless you intentionally want anonymous/browser-level `stableID` bucketing.
4. In Statsig Diagnostics, use "Check Group for a User" with the same `userID` or `customIDs` you enter in the sandbox.
5. Confirm both groups set `variant_id` exactly, for example `control` and `test`.
6. Add an override if you need to force a user into each arm while testing.
7. Refresh the sandbox config and confirm the rendered placement arm changes to the expected `variantId`.

For Statsig Autotune or contextual bandits:

1. Use the same placement setup: Tranzmit still only needs the returned `variant_id`.
2. Keep identities stable while you test repeated visits; bandits can change allocation over time.
3. For contextual bandits, pass the full context in `userTraits` before fetching config.
4. Monitor the bandit in Statsig and use a linked holdback experiment if you want a clean baseline against the non-bandit experience.

Relevant Statsig docs:

- User object and identifier requirements: https://docs.statsig.com/sdks/user
- Experiment overrides and "Check Group for a User": https://docs.statsig.com/experiments/setup/overrides
- Autotune / multi-armed bandits: https://docs.statsig.com/autotune/overview
- Advanced bandit usage: https://docs.statsig.com/using-bandits

## Deploy

Railway with Postgres addon. See `Dockerfile`.
