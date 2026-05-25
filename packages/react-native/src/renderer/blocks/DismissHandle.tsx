import { Pressable, Text, View } from "react-native";
import type { NativeTheme } from "../theme.js";
import { createPaywallStyles } from "../theme.js";
import type { PresentationMode } from "../../types.js";

export function DismissHandle({
  presentation,
  theme,
  onDismiss,
}: {
  presentation: PresentationMode;
  theme: NativeTheme;
  onDismiss: () => void;
}) {
  const styles = createPaywallStyles(theme);

  if (presentation === "sheet") {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel="Close paywall" onPress={onDismiss}>
        <View style={styles.sheetHandle} />
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close paywall"
      onPress={onDismiss}
      style={styles.closeButton}
    >
      <Text style={styles.closeText}>×</Text>
    </Pressable>
  );
}
