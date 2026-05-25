import { Pressable, Text } from "react-native";
import type { PaywallSpec } from "@tranzmit/shared";
import type { NativeTheme } from "../theme.js";
import { createPaywallStyles } from "../theme.js";

export function LegalText({
  spec,
  theme,
  onDismiss,
}: {
  spec: PaywallSpec;
  theme: NativeTheme;
  onDismiss: () => void;
}) {
  const styles = createPaywallStyles(theme);
  const text = spec.secondaryCta || spec.legal || (typeof spec.cta === "string" ? undefined : spec.cta.subtext);
  if (!text) return null;

  return (
    <Pressable accessibilityRole="button" onPress={onDismiss}>
      <Text style={styles.secondaryText}>{text}</Text>
    </Pressable>
  );
}
