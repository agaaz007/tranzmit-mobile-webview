import { Image, Text, View } from "react-native";
import type { PaywallSpec } from "@tranzmit/shared";
import type { NativeTheme } from "../theme.js";
import { createPaywallStyles } from "../theme.js";

export function HeaderBlock({ spec, theme }: { spec: PaywallSpec; theme: NativeTheme }) {
  const styles = createPaywallStyles(theme);
  const firstImage = spec.header?.imageUrl || (spec.assets?.images ? Object.values(spec.assets.images)[0] : undefined);
  const title = spec.header?.title || spec.headline || "";
  const subtitle = spec.header?.subtitle || spec.subheadline;

  return (
    <View style={styles.header}>
      {firstImage ? (
        <Image
          source={{ uri: firstImage }}
          resizeMode="cover"
          style={{ borderRadius: theme.radius, height: 140, marginBottom: 18, width: "100%" }}
        />
      ) : null}
      {spec.header?.icon ? <Text style={[styles.headline, { marginBottom: 8 }]}>{spec.header.icon}</Text> : null}
      <Text style={styles.headline}>{title}</Text>
      {subtitle ? <Text style={styles.subheadline}>{subtitle}</Text> : null}
    </View>
  );
}
