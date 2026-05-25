import { Pressable, Text } from "react-native";
import type { ProductSpec } from "@tranzmit/shared";
import type { NativeTheme } from "../theme.js";
import { createPaywallStyles } from "../theme.js";

let Haptics: any = null;
try {
  Haptics = require("expo-haptics");
} catch {
  Haptics = null;
}

export interface CTAButtonProps {
  label: string;
  product?: ProductSpec;
  theme: NativeTheme;
  onCTA: (product: ProductSpec) => void;
}

export function CTAButton({ label, product, theme, onCTA }: CTAButtonProps) {
  const styles = createPaywallStyles(theme);
  const disabled = !product;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        if (!product) return;
        void Haptics?.impactAsync?.(Haptics.ImpactFeedbackStyle?.Medium || "medium");
        onCTA(product);
      }}
      style={[styles.cta, disabled && styles.ctaDisabled]}
    >
      <Text style={styles.ctaText}>{label}</Text>
    </Pressable>
  );
}
