# Agent Guide: tranzmit-flutter-sdk

This file is for Claude, Codex, Cursor agents, and other coding agents integrating the Tranzmit Flutter SDK into a customer Flutter app.

## Package Identity

- Distribution/repo name: `tranzmit-flutter-sdk`
- Dart package name: `tranzmit_flutter`
- Import: `package:tranzmit_flutter/tranzmit_flutter.dart`
- Main provider: `TranzmitProvider`
- Runtime accessor: `Tranzmit.of(context)`
- Default placement trigger: `upgrade_pro`

Do not rename the Dart package to `tranzmit-flutter-sdk`; Dart package names cannot contain hyphens.

## Integration Goal

The host app should not contain hardcoded paywall UI. The app initializes the SDK with a Tranzmit public key, asks Tranzmit to present a placement at the monetization moment, and handles native billing when the user taps the CTA.

Tranzmit controls:

- Paywall copy and layout.
- Hosted WebView document delivery.
- Placement activation and pause state.
- Statsig-backed variant assignment.
- Paywall event collection.

The host app controls:

- Authentication and app user IDs.
- Native purchase flow.
- Entitlement grants.
- Restore purchases.
- Refunds and subscription provider logic.

## Required Dependency

Add the package to the customer app's `pubspec.yaml`.

For a git dependency:

```yaml
dependencies:
  tranzmit_flutter:
    git:
      url: https://github.com/YOUR_ORG/tranzmit-flutter-sdk.git
      ref: main
```

For a local vendored dependency:

```yaml
dependencies:
  tranzmit_flutter:
    path: ./tranzmit-flutter-sdk
```

Then run:

```bash
flutter pub get
```

## Root App Setup

Wrap the app with `TranzmitProvider`.

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

The SDK defaults to the hosted Tranzmit API. If the Tranzmit team supplies an explicit API URL, set `apiBaseUrl`.

```dart
TranzmitConfig(
  publicKey: 'pk_live_REPLACE_WITH_CUSTOMER_PUBLIC_KEY',
  apiBaseUrl: 'https://api-production-2146.up.railway.app',
  userId: currentUserOrNull?.id,
)
```

## Identity Rules

Always pass `userId` when the app has a logged-in user. Omit `userId` when the user is logged out.

The SDK always adds a generated `stableID` under `identity.identifiers.stableID`. For paywall experiments, Statsig should bucket on `stableID` so logged-out and logged-in requests from the same install keep the same paywall variant.

Logged-out payload shape:

```json
{
  "identity": {
    "identifiers": {
      "stableID": "trz_install_generated_by_sdk"
    }
  }
}
```

Logged-in payload shape:

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

Do not generate a random `userId` for logged-out users. Let the SDK's `stableID` handle anonymous bucketing.

## Presenting The Paywall

Call `presentPlacement` where the app normally starts an upgrade flow.

```dart
final tranzmit = Tranzmit.of(context);

final result = tranzmit.presentPlacement(
  'upgrade_pro',
  onCTA: (product) async {
    await purchaseProduct(product.id);

    tranzmit.reportConversion({
      'trigger': 'upgrade_pro',
      'productId': product.id,
      'revenue': 999,
      'currency': 'INR',
    });
  },
);

if (!result.shown) {
  debugPrint('Tranzmit placement not shown');
}
```

`onCTA` receives the product selected in the paywall. The app must call its billing system and only call `reportConversion()` after billing succeeds.

## Native Billing

Use the customer's existing billing provider. Common options:

- RevenueCat.
- Google Play Billing.
- StoreKit.
- A custom subscription service.

Do not call `reportConversion()` before the native purchase succeeds. Do not grant entitlements in Tranzmit.

## QA Checklist

After integration:

1. Launch the app and confirm no `onError` logs.
2. Confirm `Tranzmit.of(context).getPlacement('upgrade_pro')` returns a placement after init.
3. Call `presentPlacement('upgrade_pro')` and confirm the remote paywall renders.
4. Tap CTA and confirm the host purchase flow starts.
5. Complete a test purchase and confirm `reportConversion()` runs.
6. Change paywall copy or variant setup in the dashboard.
7. Call `await Tranzmit.of(context).refreshConfig()`.
8. Present again and confirm remote changes are visible.

## Statsig Checklist

For dynamic paywalls:

1. The dashboard client must have a Statsig server secret env var configured.
2. The placement must have a Statsig experiment id.
3. The Statsig experiment must return a parameter named `variant_id`.
4. `variant_id` values must match Tranzmit variant keys exactly.
5. Paywall experiments should bucket on custom id `stableID`.
6. Logged-in apps should still pass real `userId` for analytics.

Expected variant keys for the current demo setup:

- `control`
- `intro_offer`
- `annual_pro`

## Common Mistakes

- Importing the wrong package name. Use `tranzmit_flutter`, not `tranzmit-flutter-sdk`.
- Calling `presentPlacement()` before `TranzmitProvider` is in the widget tree.
- Forgetting to pass the public key supplied by Tranzmit.
- Generating random logged-out user IDs instead of relying on `stableID`.
- Hardcoding paywall UI in the host app.
- Calling conversion before billing succeeds.
- Using Statsig values that do not match Tranzmit variant keys.
