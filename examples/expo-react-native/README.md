# Expo React Native Testbed

Use this to smoke-test `@tranzmit/react-native` in Expo before publishing.

```sh
npx create-expo-app tranzmit-expo-test --template blank-typescript
cd tranzmit-expo-test
npm install @react-native-async-storage/async-storage react-native-webview
npm install /path/to/tranzmit-mobile-webview/packages/shared
npm install /path/to/tranzmit-mobile-webview/packages/react-native
```

Replace the generated `App.tsx` with `examples/expo-react-native/App.tsx`, set a real public key, trigger, and `apiBaseUrl`, then run:

```sh
npx expo start
```

The example opens a WebView paywall via `gate()` and also shows the declarative `<TranzmitPaywall />` path.

## Auth / userId

`userId` is optional. Use your real auth id when available:

```tsx
<TranzmitProvider
  publicKey="pk_live_xxx"
  userId={user?.id}
  apiBaseUrl="https://your-tranzmit-api.example.com"
>
```

- **Before login:** omit `userId` (undefined). The SDK initializes with a device `stableID`.
- **After login:** pass `user?.id`. The provider re-inits automatically.
- **Do not** pass placeholder ids like `"guest"` at startup.

If paywalls are login-only, you can instead mount `TranzmitProvider` only after `user` exists.

## Purchase Hook

Tranzmit only owns the paywall UI and WebView bridge. Your app owns the actual purchase:

```tsx
const { gate, reportConversion, refreshConfig } = useTranzmit();

gate("upgrade_pro", {
  onCTA: async (product) => {
    await startNativePurchase(product.id); // StoreKit, Play Billing, RevenueCat, etc.
    reportConversion({
      trigger: "upgrade_pro",
      productId: product.id,
      revenue: 9.99,
      currency: "USD",
    });
  },
  onFallback: ({ reason }) => {
    console.warn("[Tranzmit] fallback", reason);
    openExistingInAppPaywall();
  },
});

// During QA, call this after saving a paywall in the dashboard.
await refreshConfig();
```

The SDK calls `POST /v1/config` and hosted `/v1/paywall-documents/...` URLs for you during init/refresh. You do not fetch those endpoints manually.

Hosted WebView documents are hydrated and cached by the SDK, so the last fetched paywall can render offline.
