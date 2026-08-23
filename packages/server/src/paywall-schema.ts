import Ajv, { type ErrorObject } from "ajv";
import { validateLocalizationCoverage } from "@tranzmit/shared";

const colorProperties = {
  backgroundColor: { type: "string" },
  accentColor: { type: "string" },
  textColor: { type: "string" },
  secondaryTextColor: { type: "string" },
  gradientColors: {
    type: "array",
    prefixItems: [{ type: "string" }, { type: "string" }],
    minItems: 2,
    maxItems: 2,
  },
  cornerRadius: { type: "number" },
  fontFamily: { type: "string" },
} as const;

const productPriceSchema = {
  oneOf: [
    { type: "string", minLength: 1 },
    {
      type: "object",
      additionalProperties: false,
      required: ["amount", "currency"],
      properties: {
        amount: { type: "number" },
        currency: { type: "string", minLength: 1 },
        interval: { type: "string" },
      },
    },
  ],
} as const;

export const paywallSpecSchema = {
  $id: "https://tranzmit.dev/schemas/paywall-spec.json",
  type: "object",
  additionalProperties: false,
  required: ["renderer", "document", "products", "cta", "dismiss"],
  properties: {
    renderer: {
      enum: ["webview"],
    },
    layout: {
      enum: [
        "stack",
        "hero",
        "comparison",
        "minimal",
        "hero_vertical",
        "hero_horizontal",
        "compact",
        "fullscreen",
        "custom",
        "influish_intro_offer",
        "influish_free_trial",
        "influish_annual_pro",
      ],
    },
    templateId: { type: "string" },
    revision: {
      oneOf: [{ type: "string" }, { type: "number" }],
    },
    cacheKey: { type: "string" },
    presentation: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: ["sheet", "modal", "fullscreen", "inline"] },
      },
    },
    design: {
      type: "object",
      additionalProperties: false,
      required: ["source", "version", "artboard"],
      properties: {
        source: { type: "string", minLength: 1 },
        version: { type: "number" },
        artboard: {
          type: "object",
          additionalProperties: false,
          required: ["id", "width", "height"],
          properties: {
            id: { type: "string", minLength: 1 },
            name: { type: "string" },
            width: { type: "number", minimum: 1 },
            height: { type: "number", minimum: 1 },
          },
        },
        breakpoints: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "width", "height"],
            properties: {
              id: { type: "string", minLength: 1 },
              width: { type: "number", minimum: 1 },
              height: { type: "number", minimum: 1 },
              scale: { type: "number" },
            },
          },
        },
      },
    },
    document: {
      type: "object",
      additionalProperties: false,
      anyOf: [
        { required: ["html"] },
        { required: ["url"] },
      ],
      properties: {
        html: { type: "string", minLength: 1 },
        css: { type: "string" },
        js: { type: "string" },
        baseUrl: { type: "string" },
        url: { type: "string", minLength: 1 },
        integrity: { type: "string" },
        cacheTtlSeconds: { type: "number", minimum: 0 },
      },
    },
    bridge: {
      type: "object",
      additionalProperties: false,
      required: ["version"],
      properties: {
        version: { const: 1 },
        allowedActions: {
          type: "array",
          items: { enum: ["cta", "dismiss", "custom_action", "open_url"] },
        },
      },
    },
    security: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowedOrigins: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^https?://[^*/?#@\\s]+$",
          },
        },
        externalUrlHosts: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$",
          },
        },
        externalUrlSchemes: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^[a-z][a-z0-9+.-]*$",
          },
        },
      },
    },
    checkout: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: {
          type: "object",
          additionalProperties: true,
        },
        ui: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            showToggle: { type: "boolean" },
            appPriority: {
              type: "array",
              maxItems: 32,
              items: {
                type: "string",
                pattern: "^[A-Za-z0-9._-]{1,64}$",
              },
            },
            defaultApp: {
              type: "string",
              pattern: "^[A-Za-z0-9._-]{1,64}$",
            },
            maxVisibleApps: {
              type: "integer",
              minimum: 1,
              maximum: 12,
            },
            iconStyle: { enum: ["tile", "circle"] },
            fallbackToPlainCta: { type: "boolean" },
          },
        },
      },
    },
    header: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1 },
        subtitle: { type: "string" },
        imageUrl: { type: "string" },
        icon: { type: "string" },
        alignment: { enum: ["left", "center"] },
      },
    },
    products: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "price"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          price: productPriceSchema,
          originalPrice: { type: "string" },
          badge: { type: "string" },
          features: { type: "array", items: { type: "string" } },
          isDefault: { type: "boolean" },
          highlighted: { type: "boolean" },
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
    cta: {
      oneOf: [
        { type: "string", minLength: 1 },
        {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1 },
            subtext: { type: "string" },
          },
        },
      ],
    },
    secondaryCta: { type: "string" },
    theme: { enum: ["light", "dark", "auto"] },
    socialProof: { type: "boolean" },
    features: {
      type: "array",
      items: {
        oneOf: [
          { type: "string", minLength: 1 },
          {
            type: "object",
            additionalProperties: false,
            required: ["text", "included"],
            properties: {
              text: { type: "string", minLength: 1 },
              included: { type: "boolean" },
            },
          },
        ],
      },
    },
    social_proof: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1 },
        rating: { type: "number" },
        review_count: { type: "number" },
      },
    },
    urgency: {
      type: "object",
      additionalProperties: false,
      required: ["text", "type"],
      properties: {
        text: { type: "string", minLength: 1 },
        type: { enum: ["countdown", "text"] },
        deadline: { type: "string" },
      },
    },
    legal: { type: "string" },
    assets: {
      type: "object",
      additionalProperties: false,
      properties: {
        images: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        fonts: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    localization: {
      type: "object",
      additionalProperties: false,
      required: ["defaultLocale", "translations"],
      properties: {
        defaultLocale: {
          type: "string",
          pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
        },
        translations: {
          type: "object",
          minProperties: 1,
          propertyNames: {
            pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
          },
          additionalProperties: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
    metadata: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    customHtml: { type: "string" },
    customCss: { type: "string" },
    style: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...colorProperties,
        ctaStyle: {
          type: "object",
          additionalProperties: false,
          properties: {
            backgroundColor: { type: "string" },
            textColor: { type: "string" },
            borderRadius: { type: "number" },
          },
        },
        productCardStyle: {
          type: "object",
          additionalProperties: false,
          properties: {
            backgroundColor: { type: "string" },
            borderColor: { type: "string" },
            selectedBorderColor: { type: "string" },
          },
        },
      },
    },
    dismiss: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        delay_ms: { type: "number", minimum: 0 },
        // Optional placement override for the SDK-rendered fullscreen close (×)
        // button: nudge (dx/dy) + shrink (scale) it into a clean top-left corner.
        anchor: {
          type: "object",
          additionalProperties: false,
          properties: {
            dx: { type: "number" },
            dy: { type: "number" },
            scale: { type: "number", minimum: 0.5, maximum: 1 },
          },
        },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(paywallSpecSchema);

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string; keyword: string }>;
  warnings: Array<{ path: string; message: string; keyword: string }>;
}

// Size guardrails for spec.document (html+css+js bytes). Oversized documents
// caused a production incident on 2026-07-06: 271-290KB documents (base64
// PNGs inlined into the html) exceeded the Flutter SDK's 8s fetch timeout on
// cellular, so ~55% of test-variant users silently got the app fallback.
// Warn above 100KB; reject above 512KB so it can never silently regress that
// far again. Fix for large images: re-encode to WebP or host them as real
// URLs instead of data URIs.
const DOCUMENT_WARN_BYTES = 100_000;
const DOCUMENT_REJECT_BYTES = 512_000;

type JsonRecord = Record<string, any>;

// `hi-en` was emitted by the legacy HiAstro authoring flow for Latin-script
// Hindi. Keep V2 authoring strict, but canonicalize that exact historical
// alias while copying legacy rows into immutable V2 releases.
export function normalizeLegacyPaywallSpecForV2<T extends JsonRecord>(spec: T): T {
  const copy = structuredClone(spec);
  const localization = isJsonRecord(copy.localization) ? copy.localization : null;
  const translations = isJsonRecord(localization?.translations)
    ? localization.translations
    : null;
  if (!localization || !translations || !("hi-en" in translations)) return copy;

  const legacyHindi = translations["hi-en"];
  const canonicalHindi = translations["hi-Latn"];
  if (canonicalHindi !== undefined && stableJsonValue(canonicalHindi) !== stableJsonValue(legacyHindi)) {
    // Conflicting authored copy needs human resolution. Leave it untouched so
    // the normal V2 locale validator blocks publication.
    return copy;
  }

  if (canonicalHindi === undefined) {
    translations["hi-Latn"] = structuredClone(legacyHindi);
  }
  delete translations["hi-en"];
  if (localization.defaultLocale === "hi-en") localization.defaultLocale = "hi-Latn";

  const metadata = isJsonRecord(copy.metadata) ? copy.metadata : null;
  if (metadata?.defaultLocale === "hi-en") metadata.defaultLocale = "hi-Latn";

  const normalizedHindi = translations["hi-Latn"];
  if (isJsonRecord(normalizedHindi) && normalizedHindi.html_lang === "hi-en") {
    normalizedHindi.html_lang = "hi-Latn";
  }
  return copy;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  if (isJsonRecord(value)) {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJsonValue(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function documentBytes(spec: unknown): number {
  const document = (spec as { document?: unknown } | null)?.document;
  if (!document || typeof document !== "object") return 0;
  let total = 0;
  for (const key of ["html", "css", "js"] as const) {
    const value = (document as Record<string, unknown>)[key];
    if (typeof value === "string") total += Buffer.byteLength(value, "utf8");
  }
  return total;
}

export function validatePaywallSpec(spec: unknown): ValidationResult {
  const valid = validate(spec);
  const result: ValidationResult = {
    valid,
    errors: valid ? [] : formatErrors(validate.errors || []),
    warnings: [],
  };
  if (!result.valid) return result;

  const localization = (spec as { localization?: {
    defaultLocale?: unknown;
    translations?: Record<string, unknown>;
  } } | null)?.localization;
  if (localization) {
    const tags = new Map<string, string>([
      ["/localization/defaultLocale", String(localization.defaultLocale || "")],
      ...Object.keys(localization.translations || {}).map(
        (tag) => [`/localization/translations/${tag}`, tag] as [string, string]
      ),
    ]);
    for (const [path, tag] of tags) {
      if (!isCanonicalRegisteredLocale(tag)) {
        result.errors.push({
          path,
          message: `"${tag}" must be a canonical registered BCP-47 locale tag`,
          keyword: "locale",
        });
      }
    }
  }

  result.errors.push(...validateLocalizationCoverage(spec as any).issues);
  if (result.errors.length > 0) {
    result.valid = false;
    return result;
  }

  const bytes = documentBytes(spec);
  if (bytes > DOCUMENT_REJECT_BYTES) {
    result.valid = false;
    result.errors.push({
      path: "/document",
      message:
        `document html+css+js is ${bytes.toLocaleString()} bytes (limit ${DOCUMENT_REJECT_BYTES.toLocaleString()}). ` +
        "Documents this large time out on cellular and users silently get the fallback paywall. " +
        "Re-encode inlined images to WebP or host them as URLs instead of data URIs.",
      keyword: "maxDocumentBytes",
    });
  } else if (bytes > DOCUMENT_WARN_BYTES) {
    result.warnings.push({
      path: "/document",
      message:
        `document html+css+js is ${bytes.toLocaleString()} bytes (>${DOCUMENT_WARN_BYTES.toLocaleString()}). ` +
        "Large documents load slowly on cellular; keep paywalls lean (WebP images, hosted assets).",
      keyword: "documentSizeWarning",
    });
  }
  return result;
}

function isCanonicalRegisteredLocale(tag: string): boolean {
  if (!tag) return false;
  try {
    const canonical = Intl.getCanonicalLocales(tag);
    if (canonical.length !== 1 || canonical[0] !== tag) return false;

    // getCanonicalLocales validates structure and casing but accepts unknown
    // language/region codes. When full ICU data is available on the server,
    // reject those too (for example hi-EN).
    const locale = new Intl.Locale(tag);
    const DisplayNames = (Intl as any).DisplayNames;
    if (!DisplayNames) return true;
    const known = (type: "language" | "region" | "script", value: string | undefined) => {
      if (!value) return true;
      const names = new DisplayNames(["en"], { type, fallback: "none" });
      return names.of(value) !== undefined;
    };
    return known("language", locale.language)
      && known("script", locale.script)
      && known("region", locale.region);
  } catch {
    return false;
  }
}

function formatErrors(errors: ErrorObject[]): ValidationResult["errors"] {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    message: error.message || "Invalid value",
    keyword: error.keyword,
  }));
}
