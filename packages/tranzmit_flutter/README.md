# tranzmit-flutter-sdk

Client Flutter SDK for Tranzmit server-driven paywalls. The SDK fetches remote placement config, renders hosted paywall documents, assigns users through Statsig-backed experiments, and sends impression / CTA / dismissal / conversion events back to Tranzmit.

The git repository or distribution folder can be named `tranzmit-flutter-sdk`. The Dart package name is `tranzmit_flutter` because Dart package imports use underscores, not hyphens.

## What Customers Need

To integrate Tranzmit, a customer app needs:

- The Tranzmit Flutter package.
- A Tranzmit public key from the dashboard, for example `pk_live_...` or `pk_test_...`.
- A placement trigger configured in the dashboard, usually `upgrade_pro`.
- A stable app user id when the user is logged in.
- A native purchase implementation in the host app: StoreKit, Google Play Billing, RevenueCat, or another billing provider.

Once the public key and placement are configured in the dashboard, paywall changes and experiment splits flow remotely. The customer should not hardcode paywall UI in their app.

## Install

If this SDK is shared as a standalone git repo:

```yaml
dependencies:
  tranzmit_flutter:
    git:
      url: https://github.com/YOUR_ORG/tranzmit-flutter-sdk.git
      ref: main
```

If this SDK is vendored locally during development:

```yaml
dependencies:
  tranzmit_flutter:
    path: ./tranzmit-flutter-sdk
```

Then run:

```bash
flutter pub get
```

## Initialize

Wrap the app with `TranzmitProvider` near the root of the widget tree, above any screen that may show a paywall.

```dart
import 'package:flutter/material.dart';
import 'package:tranzmit_flutter/tranzmit_flutter.dart';

void main() {
  runApp(
    TranzmitProvider(
      config: TranzmitConfig(
        publicKey: 'pk_live_REPLACE_WITH_CUSTOMER_PUBLIC_KEY',
        userId: currentUserOrNull?.id,
      ),
      onError: (error) {
        debugPrint('[Tranzmit] ${error.code}: ${error.message}');
      },
      child: const MyApp(),
    ),
  );
}
```

`apiBaseUrl` is optional for production because the SDK defaults to the hosted Tranzmit API. If a Tranzmit engineer gives you a custom API URL, pass it explicitly:

```dart
TranzmitConfig(
  publicKey: 'pk_live_REPLACE_WITH_CUSTOMER_PUBLIC_KEY',
  apiBaseUrl: 'https://api-production-2146.up.railway.app',
  userId: currentUserOrNull?.id,
)
```

## Identity And Statsig Bucketing

Tranzmit always sends an install-level `stableID`.

When the user is logged out, the SDK sends:

```json
{
  "identity": {
    "identifiers": {
      "stableID": "trz_install_generated_by_sdk"
    }
  }
}
```

When the user is logged in, the SDK sends both the app user id and the same stable install id:

```json
{
  "identity": {
    "userId": "customer_app_user_123",
    "identifiers": {
      "stableID": "trz_install_generated_by_sdk"
    }
  }
}
```

For paywall experiments, configure Statsig to bucket on the custom id `stableID`. This keeps a user's paywall assignment consistent before and after login. The real `userId` is still included for logged-in analytics and event analysis.

The SDK persists `stableID` in `SharedPreferences` per Tranzmit public key. It remains stable across app launches, but can reset if the user uninstalls the app, clears app data, or device storage is unavailable.

## Present A Paywall

Use the trigger configured in the Tranzmit dashboard. The default trigger used by the demo client is `upgrade_pro`.

```dart
final tranzmit = Tranzmit.of(context);

final result = tranzmit.presentPlacement(
  'upgrade_pro',
  onCTA: (product) async {
    // Tranzmit owns paywall rendering. The host app owns billing.
    await purchaseWithStoreKitPlayBillingOrRevenueCat(product.id);

    tranzmit.reportConversion({
      'trigger': 'upgrade_pro',
      'productId': product.id,
      'revenue': 999,
      'currency': 'INR',
    });
  },
  onDismiss: () {
    debugPrint('Tranzmit paywall dismissed');
  },
  onImpression: () {
    debugPrint('Tranzmit paywall impression tracked');
  },
);

if (!result.shown) {
  debugPrint('No active Tranzmit placement for upgrade_pro');
}
```

## Purchase Ownership

Tranzmit does not call StoreKit, Google Play Billing, or RevenueCat. The WebView bridge emits a CTA event with the selected `product.id`; the host app must:

1. Start the native purchase flow.
2. Grant entitlements using the app's existing billing system.
3. Call `reportConversion()` only after a successful purchase.

This keeps purchases, restores, refunds, subscriptions, and entitlements under the customer app's control.

## Refresh During QA

Dashboard changes are fetched automatically through the server TTL cache. During QA, after saving a paywall or experiment change in the dashboard, force refresh:

```dart
await Tranzmit.of(context).refreshConfig();
```

Then call `presentPlacement('upgrade_pro')` again.

## Events

The SDK automatically tracks:

- `page_view` after successful SDK initialization.
- `impression` when a paywall is shown.
- `cta_click` when the paywall CTA is tapped.
- `dismissal` when the paywall is dismissed.
- `conversion` when the host app calls `reportConversion()`.

Events are queued locally, flushed at 10 events or after 30 seconds, flushed when the app backgrounds, and flushed immediately for conversions.

## Remote Config Behavior

On init, the SDK calls:

- `POST /v1/config` to fetch placements, specs, variant assignments, and hosted document URLs.
- Hosted document URLs to hydrate WebView HTML/CSS.
- `POST /v1/events` to send analytics events.

Config is cached locally. The SDK can render a previously cached config while a fresh network request runs in the background.

## Troubleshooting Checklist

If a paywall does not show:

1. Confirm `TranzmitProvider` wraps the current widget tree.
2. Confirm the public key is correct for the dashboard client.
3. Confirm the placement trigger exists and is active in the dashboard.
4. Confirm the app calls `presentPlacement('upgrade_pro')` after SDK init.
5. Check `onError` logs for `config_fetch_failed`, `paywall_document_fetch_failed`, or HTTP status codes.
6. Call `await Tranzmit.of(context).refreshConfig()` after dashboard edits.
7. Confirm the device can reach the Tranzmit API and hosted document URLs.

If Statsig buckets look wrong:

1. Confirm the dashboard placement has the correct Statsig experiment id.
2. Confirm Statsig has a parameter named exactly `variant_id`.
3. Confirm `variant_id` values match dashboard variant keys exactly, such as `control`, `intro_offer`, and `annual_pro`.
4. Confirm Statsig buckets on the custom id `stableID` for paywall experiments.
5. For logged-in users, still pass `userId` for analytics hygiene.

## Agent Implementation Notes

For Claude, Codex, or another coding agent integrating this SDK into a customer app:

1. Add the `tranzmit_flutter` dependency.
2. Run `flutter pub get`.
3. Import `package:tranzmit_flutter/tranzmit_flutter.dart`.
4. Wrap the root app with `TranzmitProvider`.
5. Pass the Tranzmit public key supplied by the Tranzmit team.
6. Pass `userId` when available; omit it when logged out.
7. Use `presentPlacement('upgrade_pro')` at the upgrade or monetization moment.
8. Wire `onCTA` to the app's existing billing provider.
9. Call `reportConversion()` only after billing succeeds.
10. Do not hardcode paywall UI. Tranzmit dashboard controls design, copy, products, placement status, and experiment variants.

## Supported Layouts

The renderer supports these server-driven layout names:

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
- `custom` as a stack fallback
