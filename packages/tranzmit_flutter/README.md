# Tranzmit Flutter SDK

Native Flutter SDK for fetching Tranzmit placement config, rendering paywalls, and tracking paywall events.

## Install

```yaml
dependencies:
  tranzmit_flutter:
    path: packages/tranzmit_flutter
```

## Basic Usage

```dart
import 'package:tranzmit_flutter/tranzmit_flutter.dart';

TranzmitProvider(
  config: const TranzmitConfig(
    publicKey: 'pk_test_ee6faecba4e36ea5d3e66388',
    apiBaseUrl: 'https://your-tranzmit-api.up.railway.app',
  ),
  child: const MyApp(),
);
```

Present a server-driven placement:

```dart
final tranzmit = Tranzmit.of(context);
tranzmit.presentPlacement(
  'upgrade_pro',
  onCTA: (product) async {
    // IMPORTANT: Tranzmit owns the paywall UI. Your app owns the purchase.
    await purchaseWithStoreKitPlayBillingOrRevenueCat(product.id);
    tranzmit.reportConversion({
      'trigger': 'upgrade_pro',
      'productId': product.id,
      'revenue': 9.99,
      'currency': 'USD',
    });
  },
);
```

## Purchase Ownership

Tranzmit does **not** call StoreKit, Google Play Billing, or RevenueCat for you. The WebView bridge sends a CTA event with the selected `product.id`; your app must start the native purchase and call `reportConversion()` after success. This keeps entitlements, restore purchases, refunds, and subscription provider choice under the customer app's control.

If you save a paywall in the dashboard during QA, call:

```dart
await Tranzmit.of(context).refreshConfig();
```

Production apps also use the server TTL cache, and hosted WebView documents are cached locally for offline rendering.

Track a conversion:

```dart
Tranzmit.of(context).reportConversion({
  'trigger': 'upgrade_pro',
  'productId': 'pro_monthly',
  'revenue': 9.99,
  'currency': 'USD',
});
```

## RN to Flutter Mapping

| React Native SDK | Flutter SDK |
| --- | --- |
| `TranzmitProvider` | `TranzmitProvider` |
| `useTranzmit()` | `Tranzmit.of(context)` |
| `gate('upgrade_pro')` | `presentPlacement('upgrade_pro')` |
| `TranzmitPaywall` | `TranzmitPaywall` |
| `PaywallHost` | internal `TranzmitPaywallHost` |
| `SpecRenderer` | `SpecRenderer` |

## Behavior Parity

The Flutter SDK mirrors the React Native shared client behavior:

- `POST /v1/config` and `POST /v1/events`
- per-public-key stable IDs
- TTL-aware config caching
- cache-first initialization with background refresh
- event queue max of 100
- auto-flush at 10 events or after 30 seconds
- flush on background and conversion
- session rotation on foreground
- `impression`, `cta_click`, `dismissal`, `conversion`, and `page_view` events

## Supported Layouts

The renderer supports the same layout names as the RN SDK and maps unsupported custom behavior to the stack layout:

- `stack`
- `hero`
- `hero_vertical`
- `hero_horizontal`
- `comparison`
- `minimal`
- `compact`
- `fullscreen`
- `influish_intro_offer`
- `influish_free_trial`
- `influish_annual_pro`
- `custom` as stack fallback
