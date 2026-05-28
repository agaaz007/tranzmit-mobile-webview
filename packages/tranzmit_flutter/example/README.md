# tranzmit-flutter-sdk Example Harness

Minimal Flutter app for validating the Tranzmit SDK against a live server. There is **no hardcoded paywall UI** in this app. Paywalls come only from remote config and hosted WebView documents.

## Run

```bash
cd packages/tranzmit_flutter/example
flutter pub get
flutter run
```

## Optional overrides

```bash
flutter run \
  --dart-define=TRANZMIT_API_BASE_URL=https://api-production-2146.up.railway.app \
  --dart-define=TRANZMIT_PUBLIC_KEY=pk_test_2a8a5f07d4b9fcf1cc77e024 \
  --dart-define=TRANZMIT_TRIGGER=upgrade_pro
```

The harness passes a demo `userId`. In a customer app, pass the real logged-in app user id when available. When logged out, omit `userId`; the SDK generates and persists a `stableID` for Statsig bucketing.

## What to verify

1. **SDK status → Ready: yes** after init
2. **Remote placement** shows variant, presentation, cache key, document URL, and **HTML hydrated: yes**
3. Tap **Present "upgrade_pro"** and confirm the paywall renders from server HTML.
4. Tap CTA and confirm the demo host purchase dialog appears, then `reportConversion` fires.
5. Edit paywall text, CSS, variant allocation, or `presentation.mode` in the dashboard.
6. Tap **Refresh config** and present again to see updates.

## Purchase ownership

Tranzmit renders the paywall. Your app owns billing. Wire `onCTA` to StoreKit / Play Billing / RevenueCat, then call `reportConversion()` after success.
