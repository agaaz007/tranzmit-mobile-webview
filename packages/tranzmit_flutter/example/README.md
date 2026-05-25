# Tranzmit Flutter SDK Harness

Minimal Flutter app for validating the Tranzmit SDK against a live server. There is **no hardcoded paywall UI** in this app — paywalls come only from remote config and hosted WebView documents.

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

## What to verify

1. **SDK status → Ready: yes** after init
2. **Remote placement** shows variant, presentation, cache key, document URL, and **HTML hydrated: yes**
3. Tap **Present "upgrade_pro"** — paywall renders from server HTML
4. Tap CTA — demo host purchase dialog appears, then `reportConversion` fires
5. Edit paywall text, CSS, or `presentation.mode` in the dashboard → tap **Refresh config** → present again to see updates

## Purchase ownership

Tranzmit renders the paywall. Your app owns billing. Wire `onCTA` to StoreKit / Play Billing / RevenueCat, then call `reportConversion()` after success.
