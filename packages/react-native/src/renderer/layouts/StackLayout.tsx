import { View } from "react-native";
import type { PaywallSpec, ProductSpec } from "@tranzmit/shared";
import { CTAButton } from "../blocks/CTAButton.js";
import { FeatureList } from "../blocks/FeatureList.js";
import { HeaderBlock } from "../blocks/HeaderBlock.js";
import { LegalText } from "../blocks/LegalText.js";
import { ProductList } from "../blocks/ProductList.js";
import type { NativeTheme } from "../theme.js";

export interface LayoutProps {
  spec: PaywallSpec;
  theme: NativeTheme;
  selectedProduct?: ProductSpec;
  onSelectProduct: (product: ProductSpec) => void;
  onCTA: (product: ProductSpec) => void;
  onDismiss: () => void;
}

export function StackLayout({
  spec,
  theme,
  selectedProduct,
  onSelectProduct,
  onCTA,
  onDismiss,
}: LayoutProps) {
  return (
    <View>
      <HeaderBlock spec={spec} theme={theme} />
      <ProductList
        products={spec.products}
        selectedProductId={selectedProduct?.id}
        theme={theme}
        onSelect={onSelectProduct}
      />
      <FeatureList spec={spec} theme={theme} />
      <CTAButton label={ctaLabel(spec)} product={selectedProduct} theme={theme} onCTA={onCTA} />
      <LegalText spec={spec} theme={theme} onDismiss={onDismiss} />
    </View>
  );
}

export function ctaLabel(spec: PaywallSpec): string {
  return typeof spec.cta === "string" ? spec.cta : spec.cta.text;
}
