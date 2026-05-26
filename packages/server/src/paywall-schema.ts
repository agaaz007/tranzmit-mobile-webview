import Ajv, { type ErrorObject } from "ajv";

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
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(paywallSpecSchema);

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string; keyword: string }>;
}

export function validatePaywallSpec(spec: unknown): ValidationResult {
  const valid = validate(spec);
  return {
    valid,
    errors: valid ? [] : formatErrors(validate.errors || []),
  };
}

function formatErrors(errors: ErrorObject[]): ValidationResult["errors"] {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    message: error.message || "Invalid value",
    keyword: error.keyword,
  }));
}
