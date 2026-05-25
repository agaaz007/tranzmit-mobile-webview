import { Pressable, Text, View } from "react-native";
import type { ProductSpec } from "@tranzmit/shared";
import type { NativeTheme } from "../theme.js";
import { createPaywallStyles, formatPrice } from "../theme.js";

export interface ProductCardProps {
  product: ProductSpec;
  selected: boolean;
  theme: NativeTheme;
  onSelect: (product: ProductSpec) => void;
}

export function ProductCard({ product, selected, theme, onSelect }: ProductCardProps) {
  const styles = createPaywallStyles(theme);
  const isSelected = selected || product.highlighted || product.isDefault;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      onPress={() => onSelect(product)}
      style={[styles.productCard, isSelected && styles.selectedProductCard]}
    >
      {product.badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{product.badge}</Text>
        </View>
      ) : null}
      <View style={{ alignItems: "center", flexDirection: "row", justifyContent: "space-between", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.productName}>{product.name}</Text>
          {product.description ? <Text style={styles.productPrice}>{product.description}</Text> : null}
          <Text style={styles.productPrice}>{formatPrice(product)}</Text>
        </View>
        <View
          style={{
            alignItems: "center",
            borderColor: isSelected ? theme.accent : theme.border,
            borderRadius: 999,
            borderWidth: 2,
            height: 22,
            justifyContent: "center",
            width: 22,
          }}
        >
          {isSelected ? (
            <View style={{ backgroundColor: theme.accent, borderRadius: 999, height: 12, width: 12 }} />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}
