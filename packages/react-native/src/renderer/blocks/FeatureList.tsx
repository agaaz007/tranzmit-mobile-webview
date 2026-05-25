import { Text, View } from "react-native";
import type { PaywallSpec } from "@tranzmit/shared";
import type { NativeTheme } from "../theme.js";
import { createPaywallStyles } from "../theme.js";

export function FeatureList({ spec, theme }: { spec: PaywallSpec; theme: NativeTheme }) {
  const styles = createPaywallStyles(theme);
  if (!spec.features?.length) return null;

  return (
    <View style={{ marginBottom: 20 }}>
      {spec.features.map((feature) => {
        const text = typeof feature === "string" ? feature : feature.text;
        const included = typeof feature === "string" ? true : feature.included;
        return (
        <View key={text} style={styles.featureRow}>
          <Text style={{ color: included ? theme.accent : theme.muted, fontSize: 16, fontWeight: "700" }}>
            {included ? "✓" : "×"}
          </Text>
          <Text style={styles.featureText}>{text}</Text>
        </View>
        );
      })}
    </View>
  );
}
