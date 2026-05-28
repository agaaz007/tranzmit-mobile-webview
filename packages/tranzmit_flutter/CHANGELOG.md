# Changelog

## 0.1.0

- Initial `tranzmit-flutter-sdk` client package.
- Added `TranzmitProvider` for app-level SDK initialization.
- Added server-driven placement fetch through `/v1/config`.
- Added hosted paywall document hydration for WebView rendering.
- Added persistent install-level `stableID` generation through `SharedPreferences`.
- Added optional app `userId` support for logged-in analytics.
- Added `presentPlacement()` for remote paywall presentation.
- Added event tracking for page views, impressions, CTA clicks, dismissals, and conversions.
- Added `reportConversion()` for host-app billing success attribution.
- Added local config caching, background refresh, event queueing, and lifecycle flush behavior.
