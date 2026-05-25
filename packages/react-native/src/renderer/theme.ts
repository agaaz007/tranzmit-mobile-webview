import { StyleSheet } from "react-native";
import type { PaywallSpec } from "@tranzmit/shared";

export interface NativeTheme {
  isDark: boolean;
  background: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  selectedBackground: string;
  radius: number;
}

export function resolveTheme(spec: PaywallSpec): NativeTheme {
  const isDark = spec.theme === "dark" || Boolean(spec.style?.gradientColors);
  return {
    isDark,
    background: spec.style?.backgroundColor || (isDark ? "#111827" : "#f3f4f6"),
    card: spec.style?.backgroundColor || (isDark ? "#1f2937" : "#ffffff"),
    text: spec.style?.textColor || (isDark ? "#f9fafb" : "#111827"),
    muted: spec.style?.secondaryTextColor || (isDark ? "#9ca3af" : "#6b7280"),
    border: spec.style?.productCardStyle?.borderColor || (isDark ? "#374151" : "#e5e7eb"),
    accent: spec.style?.accentColor || "#2563eb",
    selectedBackground: spec.style?.productCardStyle?.backgroundColor || (isDark ? "#1e3a5f" : "#eff6ff"),
    radius: spec.style?.cornerRadius || (spec.layout === "compact" || spec.layout === "minimal" ? 12 : 18),
  };
}

export function createPaywallStyles(theme: NativeTheme) {
  return StyleSheet.create({
    card: {
      backgroundColor: theme.card,
      borderRadius: theme.radius,
      padding: 24,
      width: "100%",
      maxWidth: 440,
      alignSelf: "center",
    },
    fullscreenCard: {
      backgroundColor: theme.card,
      flex: 1,
      padding: 24,
      width: "100%",
    },
    header: {
      marginBottom: 20,
      paddingRight: 28,
    },
    headline: {
      color: theme.text,
      fontSize: 26,
      fontWeight: "700",
      lineHeight: 34,
    },
    subheadline: {
      color: theme.muted,
      fontSize: 16,
      lineHeight: 24,
      marginTop: 8,
    },
    featureRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      paddingVertical: 6,
    },
    featureText: {
      color: theme.text,
      flex: 1,
      fontSize: 15,
      lineHeight: 21,
    },
    productCard: {
      borderColor: theme.border,
      borderRadius: 14,
      borderWidth: 1,
      padding: 16,
    },
    selectedProductCard: {
      backgroundColor: theme.selectedBackground,
      borderColor: theme.accent,
      borderWidth: 2,
    },
    productName: {
      color: theme.text,
      fontSize: 16,
      fontWeight: "700",
    },
    productPrice: {
      color: theme.muted,
      fontSize: 14,
      marginTop: 4,
    },
    badge: {
      alignSelf: "flex-start",
      backgroundColor: theme.accent,
      borderRadius: 999,
      marginBottom: 10,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    badgeText: {
      color: "#ffffff",
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.4,
    },
    cta: {
      alignItems: "center",
      backgroundColor: theme.accent,
      borderRadius: 12,
      justifyContent: "center",
      marginTop: 20,
      minHeight: 52,
      paddingHorizontal: 18,
      paddingVertical: 14,
    },
    ctaDisabled: {
      opacity: 0.45,
    },
    ctaText: {
      color: "#ffffff",
      fontSize: 16,
      fontWeight: "700",
    },
    secondaryText: {
      color: theme.muted,
      fontSize: 14,
      marginTop: 14,
      textAlign: "center",
      textDecorationLine: "underline",
    },
    closeButton: {
      alignItems: "center",
      height: 36,
      justifyContent: "center",
      position: "absolute",
      right: 14,
      top: 14,
      width: 36,
      zIndex: 2,
    },
    closeText: {
      color: theme.muted,
      fontSize: 28,
      lineHeight: 30,
    },
    sheetHandle: {
      alignSelf: "center",
      backgroundColor: theme.border,
      borderRadius: 999,
      height: 5,
      marginBottom: 18,
      width: 44,
    },
  });
}

export function formatPrice(product: { price: string | { amount: number; currency: string; interval?: string } }): string {
  if (typeof product.price === "string") return product.price;

  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: product.price.currency,
    }).format(product.price.amount / 100);
  } catch {
    formatted = `${(product.price.amount / 100).toFixed(2)} ${product.price.currency}`;
  }

  return product.price.interval ? `${formatted} / ${product.price.interval}` : formatted;
}
