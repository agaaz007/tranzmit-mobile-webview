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
  document?: WebViewDocumentSpec;
  bridge?: WebViewBridgeSpec;
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
  customHtml?: string;
  customCss?: string;
  metadata?: Record<string, string>;
}
