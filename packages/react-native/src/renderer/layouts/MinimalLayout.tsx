import { View } from "react-native";
import { CTAButton } from "../blocks/CTAButton.js";
import { HeaderBlock } from "../blocks/HeaderBlock.js";
import { LegalText } from "../blocks/LegalText.js";
import { ProductCard } from "../blocks/ProductCard.js";
import { ctaLabel, type LayoutProps } from "./StackLayout.js";

export function MinimalLayout({
  spec,
  theme,
  selectedProduct,
  onSelectProduct,
  onCTA,
  onDismiss,
}: LayoutProps) {
  const product = selectedProduct || spec.products[0];

  return (
    <View>
      <HeaderBlock spec={spec} theme={theme} />
      {product ? (
        <ProductCard product={product} selected theme={theme} onSelect={onSelectProduct} />
      ) : null}
      <CTAButton label={ctaLabel(spec)} product={product} theme={theme} onCTA={onCTA} />
      <LegalText spec={spec} theme={theme} onDismiss={onDismiss} />
    </View>
  );
}
