import { View } from "react-native";
import { CTAButton } from "../blocks/CTAButton.js";
import { HeaderBlock } from "../blocks/HeaderBlock.js";
import { LegalText } from "../blocks/LegalText.js";
import { ProductList } from "../blocks/ProductList.js";
import { ctaLabel, type LayoutProps } from "./StackLayout.js";

export function ComparisonLayout({
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
        horizontal={spec.products.length <= 2}
        theme={theme}
        onSelect={onSelectProduct}
      />
      <CTAButton label={ctaLabel(spec)} product={selectedProduct} theme={theme} onCTA={onCTA} />
      <LegalText spec={spec} theme={theme} onDismiss={onDismiss} />
    </View>
  );
}
