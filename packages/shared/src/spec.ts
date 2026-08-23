export interface ProductSpec {
  id: string;
  name: string;
  description?: string;
  price: string | {
    amount: number;
    currency: string;
    interval?: string;
  };
  originalPrice?: string;
  badge?: string;
  features?: string[];
  isDefault?: boolean;
  metadata?: Record<string, string>;
  highlighted?: boolean;
}

export interface AssetManifest {
  images?: Record<string, string>;
  fonts?: string[];
}

export interface PaywallLocalization {
  /** Locale used when no translation matches the active locale. */
  defaultLocale: string;
  /**
   * Map of locale -> (token key -> translated string). Document HTML references
   * these via `{{key}}` text tokens. Translations are config data and live on
   * the spec, not inside `document.html`, so they do not affect the document
   * integrity hash.
   */
  translations: Record<string, Record<string, string>>;
}

export interface WebViewDocumentSpec {
  /**
   * Inline fragment rendered by the SDK. May be omitted when `url` points to a
   * hosted document payload; SDKs hydrate and cache the hosted payload before
   * rendering.
   */
  html?: string;
  css?: string;
  js?: string;
  baseUrl?: string;
  /**
   * Hosted JSON document payload. This is intended for CDN/Railway edge caching
   * and lets config responses stay small while SDKs keep an offline copy.
   */
  url?: string;
  integrity?: string;
  cacheTtlSeconds?: number;
}

export interface WebViewBridgeSpec {
  version: 1;
  allowedActions?: Array<"cta" | "dismiss" | "custom_action" | "open_url">;
}

export interface WebViewSecuritySpec {
  /**
   * Origins the hosted paywall WebView may load. Inline HTML uses `about:blank`
   * and does not require listing here. Use exact origins such as
   * `https://paywalls.tranzmit.com`, not wildcard domains.
   */
  allowedOrigins?: string[];
  /**
   * External URL hosts the paywall may ask the host app to open. Empty means no
   * external links can escape the WebView.
   */
  externalUrlHosts?: string[];
  /**
   * URL schemes allowed for external opens. Defaults to `https`.
   */
  externalUrlSchemes?: string[];
}

export interface CheckoutUiConfig {
  /**
   * Default true. When false the SDK injects an empty checkout runtime into
   * the WebView and strips `paymentApp` from incoming cta messages.
   */
  enabled?: boolean;
  /**
   * Default true. When false the document renders plain CTA visuals while the
   * resolved default app is still attached to cta messages silently.
   */
  showToggle?: boolean;
  /** Ordered app ids (max 32, `^[A-Za-z0-9._-]{1,64}$` each; violations dropped). */
  appPriority?: string[];
  /** Selection resolution: defaultApp -> first appPriority match -> first detected. */
  defaultApp?: string;
  /** Finite integer >= 1 clamped to 1..12; anything else defaults to 5. */
  maxVisibleApps?: number;
  iconStyle?: "tile" | "circle";
  /**
   * Default true. When false the document renders an inert generic-UPI badge
   * when no apps are detected, keeping the pay-bar band height stable.
   */
  fallbackToPlainCta?: boolean;
}

export interface CheckoutSpec {
  /**
   * Opaque provider payload. Never injected into the WebView; passed verbatim
   * to the host app as `checkoutContext.provider`.
   */
  provider?: Record<string, unknown>;
  ui?: CheckoutUiConfig;
}

export type PaywallPresentationMode = "sheet" | "modal" | "fullscreen" | "inline";

export interface PaywallDesignBreakpoint {
  id: string;
  width: number;
  height: number;
  scale?: number;
}

export interface PaywallDesignDocument {
  source: string;
  version: number;
  artboard: {
    id: string;
    name?: string;
    width: number;
    height: number;
  };
  breakpoints?: PaywallDesignBreakpoint[];
}

export interface PaywallSpec {
  renderer?: "webview";
  /**
   * Legacy native layout metadata may be present on imported specs, but mobile
   * SDKs in this repo render the WebView document instead of interpreting it.
   */
  layout?: "stack" | "hero" | "comparison" | "minimal" | "hero_vertical" | "hero_horizontal" | "compact" | "fullscreen" | "custom" | "influish_intro_offer" | "influish_free_trial" | "influish_annual_pro";
  templateId?: string;
  revision?: string | number;
  cacheKey?: string;
  presentation?: {
    mode: PaywallPresentationMode;
  };
  /**
   * Source design metadata used by the server/compiler to produce responsive
   * WebView markup. SDKs do not render this directly, but it makes the artboard
   * and device breakpoints explicit in the remote spec.
   */
  design?: PaywallDesignDocument;
  document?: WebViewDocumentSpec;
  bridge?: WebViewBridgeSpec;
  security?: WebViewSecuritySpec;
  checkout?: CheckoutSpec;
  header?: {
    title: string;
    subtitle?: string;
    imageUrl?: string;
    icon?: string;
    alignment?: "left" | "center";
  };
  headline?: string;
  subheadline?: string;
  cta: string | {
    text: string;
    subtext?: string;
  };
  secondaryCta?: string;
  theme?: "light" | "dark" | "auto";
  socialProof?: boolean;
  features?: string[] | Array<{ text: string; included: boolean }>;
  social_proof?: {
    text: string;
    rating?: number;
    review_count?: number;
  };
  urgency?: {
    text: string;
    type: "countdown" | "text";
    deadline?: string;
  };
  legal?: string;
  style?: {
    backgroundColor?: string;
    accentColor?: string;
    textColor?: string;
    secondaryTextColor?: string;
    gradientColors?: [string, string];
    cornerRadius?: number;
    fontFamily?: string;
    ctaStyle?: {
      backgroundColor?: string;
      textColor?: string;
      borderRadius?: number;
    };
    productCardStyle?: {
      backgroundColor?: string;
      borderColor?: string;
      selectedBorderColor?: string;
    };
  };
  dismiss?: {
    enabled: boolean;
    delay_ms?: number;
  };
  products: ProductSpec[];
  assets?: AssetManifest;
  localization?: PaywallLocalization;
  customHtml?: string;
  customCss?: string;
  metadata?: Record<string, string>;
}
