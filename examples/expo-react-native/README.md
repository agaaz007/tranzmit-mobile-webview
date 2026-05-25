# Expo React Native Testbed

Use this to smoke-test `@tranzmit/react-native` in Expo before publishing.

```sh
npx create-expo-app tranzmit-expo-test --template blank-typescript
cd tranzmit-expo-test
npm install @react-native-async-storage/async-storage
npm install /Users/Agaaz/i-want-to-build-this-sdkf/packages/shared
npm install /Users/Agaaz/i-want-to-build-this-sdkf/packages/react-native
```

Replace the generated `App.tsx` with `examples/expo-react-native/App.tsx`, set a real public key and trigger, then run:

```sh
npx expo start
```

The example opens a WebView paywall via `gate()` and also shows the declarative `<TranzmitPaywall />` path.

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
});

// During QA, call this after saving a paywall in the dashboard.
await refreshConfig();
```

Hosted WebView documents are hydrated and cached by the SDK, so the last fetched paywall can render offline.
