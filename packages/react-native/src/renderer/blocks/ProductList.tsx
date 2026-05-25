import { View } from "react-native";
import type { ProductSpec } from "@tranzmit/shared";
import type { NativeTheme } from "../theme.js";
import { ProductCard } from "./ProductCard.js";

export interface ProductListProps {
  products: ProductSpec[];
  selectedProductId?: string;
  horizontal?: boolean;
  theme: NativeTheme;
  onSelect: (product: ProductSpec) => void;
}

export function ProductList({
  products,
  selectedProductId,
  horizontal,
  theme,
  onSelect,
}: ProductListProps) {
  return (
    <View style={{ flexDirection: horizontal ? "row" : "column", gap: 12, marginBottom: 4 }}>
      {products.map((product) => (
        <View key={product.id} style={horizontal ? { flex: 1 } : undefined}>
          <ProductCard
            product={product}
            selected={product.id === selectedProductId}
            theme={theme}
            onSelect={onSelect}
          />
        </View>
      ))}
    </View>
  );
}
