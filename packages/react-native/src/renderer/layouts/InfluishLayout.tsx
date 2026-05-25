import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { PaywallSpec, ProductSpec } from "@tranzmit/shared";
import type { LayoutProps } from "./StackLayout.js";
import { ctaLabel } from "./StackLayout.js";
import type { NativeTheme } from "../theme.js";

const PURPLE = "#6537d9";
const PURPLE_DARK = "#17172e";
const GOLD = "#e6b246";
const GREEN = "#18a957";
const LAVENDER = "#f5f1ff";

export function InfluishIntroOfferLayout(props: LayoutProps) {
  return <InfluishPaywall {...props} variant="intro" />;
}

export function InfluishFreeTrialLayout(props: LayoutProps) {
  return <InfluishPaywall {...props} variant="trial" />;
}

export function InfluishAnnualProLayout(props: LayoutProps) {
  return <InfluishAnnualProPaywall {...props} />;
}

function InfluishPaywall({
  spec,
  theme,
  selectedProduct,
  onCTA,
  onDismiss,
  variant,
}: LayoutProps & { variant: "intro" | "trial" }) {
  const product = selectedProduct || spec.products[0];
  const title = spec.header?.title || spec.headline || "";
  const subtitle = spec.header?.subtitle || spec.subheadline || "";
  const socialProof = spec.social_proof?.text || "";
  const ctaText = ctaLabel(spec);
  const fontFamily = spec.style?.fontFamily;

  return (
    <View style={styles.screen}>
      <View style={styles.closeSpacer} />
      <View style={[styles.logoRow, variant === "trial" && styles.logoRowTrial]}>
        <Logo spec={spec} />
      </View>

      <Text style={[styles.headline, fontFamily ? { fontFamily } : null]}>
        {renderHeadline(title, variant)}
      </Text>
      {subtitle ? <Text style={[styles.subtitle, fontFamily ? { fontFamily } : null]}>{subtitle}</Text> : null}

      {variant === "trial" && socialProof ? (
        <SocialProofPill spec={spec} socialProof={socialProof} />
      ) : null}

      <OfferCard spec={spec} product={product} variant={variant} theme={theme} />

      {variant === "intro" && socialProof ? (
        <CreatorProof spec={spec} socialProof={socialProof} />
      ) : null}

      <FeatureCard spec={spec} variant={variant} />
      <Testimonial spec={spec} variant={variant} />
      {variant === "intro" ? <TrustBar text={spec.legal} /> : null}

      <Pressable
        accessibilityRole="button"
        onPress={() => {
          if (product) onCTA(product);
        }}
        style={styles.cta}
      >
        <Text style={styles.ctaText}>{ctaText}{variant === "trial" ? "  →" : "  ✦"}</Text>
      </Pressable>

      {variant === "trial" && spec.legal ? (
        <Text style={styles.trialLegal}>♧  {spec.legal}</Text>
      ) : null}

      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss paywall" onPress={onDismiss} style={variant === "trial" ? styles.closeLeft : styles.closeRight}>
        <Text style={styles.closeText}>×</Text>
      </Pressable>
    </View>
  );
}

function Logo({ spec }: { spec: PaywallSpec }) {
  const logo = spec.assets?.images?.logo;
  return (
    <View style={styles.logoWrap}>
      {logo ? <Image source={{ uri: logo }} style={styles.logoImage} /> : <Text style={styles.logoMark}>In</Text>}
      <Text style={styles.logoText}>Influish</Text>
      <Text style={styles.proBadge}>PRO</Text>
    </View>
  );
}

function OfferCard({
  spec,
  product,
  variant,
}: {
  spec: PaywallSpec;
  product?: ProductSpec;
  variant: "intro" | "trial";
  theme: NativeTheme;
}) {
  if (!product) return null;
  const monthly = product.metadata?.monthly || product.description || "";
  const price = typeof product.price === "string" ? product.price : "";
  return (
    <View style={[styles.offerOuter, variant === "trial" && styles.offerOuterTrial]}>
      {product.badge ? (
        <View style={styles.ribbon}>
          <Text style={styles.ribbonText}>✦  {product.badge.toUpperCase()}  ✦</Text>
        </View>
      ) : null}
      <Text style={variant === "trial" ? styles.trialMainPrice : styles.introMainPrice}>
        {variant === "intro" ? `${product.name} ${price}` : product.name}
      </Text>
      <Text style={styles.offerSubtitle}>{variant === "trial" ? price : product.description}</Text>
      {monthly ? (
        <View style={variant === "trial" ? styles.monthlyRow : styles.monthlyChip}>
          <Text style={variant === "trial" ? styles.monthlyTextTrial : styles.monthlyText}>
            {monthly}
          </Text>
          {variant === "trial" && product.originalPrice ? <Text style={styles.originalPrice}>{product.originalPrice}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function SocialProofPill({ spec, socialProof }: { spec: PaywallSpec; socialProof: string }) {
  return (
    <View style={styles.socialPill}>
      <AvatarStack spec={spec} size={23} />
      <Text style={styles.socialPillText}>↗  {socialProof}</Text>
    </View>
  );
}

function CreatorProof({ spec, socialProof }: { spec: PaywallSpec; socialProof: string }) {
  const parts = socialProof.split("|").map((part) => part.trim());
  return (
    <View style={styles.creatorProof}>
      <AvatarStack spec={spec} size={34} />
      <Text style={styles.creatorProofText}>{parts[0]}</Text>
      {parts[1] ? <Text style={styles.creatorProofHighlight}>{parts[1]}</Text> : null}
    </View>
  );
}

function FeatureCard({ spec, variant }: { spec: PaywallSpec; variant: "intro" | "trial" }) {
  const features = (spec.features || []).map((feature) => (typeof feature === "string" ? feature : feature.text));
  const icons = ["💬", "💼", "🪄", "🛡"];
  return (
    <View style={styles.featureCard}>
      {variant === "intro" ? <Text style={styles.featureTitle}>Why creators upgrade</Text> : null}
      {features.map((feature, index) => (
        <View key={feature} style={styles.featureRow}>
          <View style={styles.featureIcon}>
            <Text style={styles.featureIconText}>{icons[index % icons.length]}</Text>
          </View>
          <Text style={styles.featureText}>{feature}</Text>
          <Text style={variant === "trial" ? styles.checkText : styles.chevronText}>{variant === "trial" ? "●" : "›"}</Text>
        </View>
      ))}
    </View>
  );
}

function Testimonial({ spec, variant }: { spec: PaywallSpec; variant: "intro" | "trial" }) {
  const image = spec.assets?.images?.testimonialAvatar;
  const name = spec.products[0]?.metadata?.testimonialName || (variant === "trial" ? "Shivani" : "Ananya");
  const followers = spec.products[0]?.metadata?.testimonialFollowers || (variant === "trial" ? "24K followers" : "31K followers");
  const text = spec.products[0]?.metadata?.testimonialText || "";
  return (
    <View style={styles.testimonial}>
      {image ? <Image source={{ uri: image }} style={styles.testimonialImage} /> : <View style={styles.testimonialFallback}><Text style={styles.testimonialFallbackText}>{name.slice(0, 1)}</Text></View>}
      <View style={styles.testimonialBody}>
        <View style={styles.testimonialHeader}>
          <Text style={styles.testimonialName}>{name}</Text>
          <Text style={styles.testimonialFollowers}>• {followers}</Text>
        </View>
        <Text style={styles.stars}>★★★★★</Text>
        <Text style={styles.testimonialText}>{text}</Text>
      </View>
    </View>
  );
}

function TrustBar({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <View style={styles.trustBar}>
      {text.split("·").map((item) => (
        <Text key={item.trim()} style={styles.trustItem}>▣ {item.trim()}</Text>
      ))}
    </View>
  );
}

function AvatarStack({ spec, size }: { spec: PaywallSpec; size: number }) {
  const avatars = ["avatar1", "avatar2", "avatar3"].map((key) => spec.assets?.images?.[key]).filter(Boolean) as string[];
  return (
    <View style={styles.avatarStack}>
      {(avatars.length ? avatars : [undefined, undefined, undefined]).map((uri, index) => (
        uri ? (
          <Image key={uri} source={{ uri }} style={[styles.avatar, { height: size, width: size, borderRadius: size / 2, marginLeft: index === 0 ? 0 : -8 }]} />
        ) : (
          <View key={index} style={[styles.avatarFallback, { height: size, width: size, borderRadius: size / 2, marginLeft: index === 0 ? 0 : -8 }]}>
            <Text style={styles.avatarFallbackText}>{index + 1}</Text>
          </View>
        )
      ))}
      <View style={[styles.avatarCount, { height: size, minWidth: size, borderRadius: size / 2, marginLeft: -8 }]}>
        <Text style={styles.avatarCountText}>99+</Text>
      </View>
    </View>
  );
}

function InfluishAnnualProPaywall({
  spec,
  selectedProduct,
  onCTA,
  onDismiss,
}: LayoutProps) {
  const product = selectedProduct || spec.products[0];
  const title = spec.header?.title || spec.headline || "";
  const subtitle = spec.header?.subtitle || spec.subheadline || "";
  const stats = splitParts(spec.social_proof?.text);
  const benefits = (spec.features || []).map((feature) => splitParts(typeof feature === "string" ? feature : feature.text));
  const testimonialName = product?.metadata?.testimonialName || "Riya";
  const testimonialFollowers = product?.metadata?.testimonialFollowers || "58K followers";
  const testimonialText = product?.metadata?.testimonialText || "";
  const logo = spec.assets?.images?.logo;
  const testimonialAvatar = spec.assets?.images?.testimonialAvatar;

  return (
    <View style={styles.annualScreen}>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss paywall" onPress={onDismiss} style={styles.annualClose}>
        <Text style={styles.closeText}>×</Text>
      </Pressable>

      <View style={styles.annualLogoRow}>
        {logo ? <Image source={{ uri: logo }} style={styles.logoImage} /> : <Text style={styles.logoMark}>In</Text>}
        <Text style={styles.logoText}>Influish</Text>
      </View>

      <Text style={styles.annualHeadline}>{title}</Text>
      {subtitle ? <Text style={styles.annualSubtitle}>{subtitle}</Text> : null}

      {stats.length ? (
        <View style={styles.annualStatsRow}>
          {[0, 1].map((index) => {
            const parts = statParts(stats, index);
            return (
              <View key={`${parts.join("-")}-${index}`} style={styles.annualStatCard}>
                <Text style={styles.annualStatIcon}>{index === 0 ? "👥" : "📈"}</Text>
                <View>
                  <Text style={styles.annualStatValue}>{parts[0]}</Text>
                  {parts[1] ? <Text style={styles.annualStatLabel}>{parts[1]}</Text> : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {product ? (
        <View style={styles.annualOfferCard}>
          {product.badge ? (
            <View style={styles.annualBadge}>
              <Text style={styles.annualBadgeText}>★ {product.badge}</Text>
            </View>
          ) : null}
          <View style={styles.annualPriceRow}>
            <Text style={styles.annualPrice}>{product.name}</Text>
            <Text style={styles.annualInterval}>{typeof product.price === "string" ? product.price : ""}</Text>
          </View>
          {product.description ? <Text style={styles.annualMonthly}>{product.description}</Text> : null}
          {product.originalPrice ? <Text style={styles.annualOriginal}>{product.originalPrice}</Text> : null}
        </View>
      ) : null}

      <View style={styles.annualBenefits}>
        {benefits.slice(0, 3).map((benefit, index) => (
          <View key={`${benefit.join("-")}-${index}`} style={styles.annualBenefitCard}>
            <Text style={styles.annualBenefitIcon}>{["💬", "💼", "🪄"][index] || "✨"}</Text>
            <Text style={styles.annualBenefitTitle}>{benefit[0]}</Text>
            {benefit[1] ? <Text style={styles.annualBenefitText}>{benefit[1]}</Text> : null}
          </View>
        ))}
      </View>

      <View style={styles.annualTestimonial}>
        {testimonialAvatar ? (
          <Image source={{ uri: testimonialAvatar }} style={styles.testimonialImage} />
        ) : (
          <View style={styles.testimonialFallback}>
            <Text style={styles.testimonialFallbackText}>{testimonialName.slice(0, 1)}</Text>
          </View>
        )}
        <View style={styles.testimonialBody}>
          <View style={styles.testimonialHeader}>
            <Text style={styles.testimonialName}>{testimonialName}</Text>
            <Text style={styles.testimonialFollowers}>• {testimonialFollowers}</Text>
          </View>
          {testimonialText ? <Text style={styles.annualQuote}>“ {testimonialText} ”</Text> : null}
        </View>
      </View>

      {spec.legal ? (
        <View style={styles.annualTrustBar}>
          {spec.legal.split("·").map((item, index) => (
            <Text key={`${item}-${index}`} style={styles.annualTrustItem}>{["▣", "♧", "⟳"][index] || "▣"} {item.trim()}</Text>
          ))}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        onPress={() => {
          if (product) onCTA(product);
        }}
        style={styles.cta}
      >
        <Text style={styles.ctaText}>{ctaLabel(spec)}  ✦</Text>
      </Pressable>

      <Text style={styles.trialLegal}>{product?.metadata?.guarantee || "7-day money-back guarantee"}</Text>
    </View>
  );
}

function splitParts(value?: string) {
  return (value || "").split("|").map((part) => part.trim()).filter(Boolean);
}

function statParts(parts: string[], index: number) {
  const first = index * 2;
  if (parts.length > first + 1) return [parts[first], parts[first + 1]];
  if (parts.length > index) return [parts[index]];
  return index === 0 ? ["8,20,737+", "creators trust Influish"] : ["42,000+", "creators earning with Pro"];
}

function renderHeadline(title: string, variant: "intro" | "trial") {
  if (variant === "intro") return title;
  return title;
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#fbfaff",
    borderRadius: 28,
    gap: 9,
    overflow: "hidden",
    paddingBottom: 4,
    paddingHorizontal: 6,
    paddingTop: 0,
  },
  closeSpacer: { height: 8 },
  closeLeft: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#ece8f5",
    borderRadius: 22,
    borderWidth: 1,
    height: 36,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    top: 0,
    width: 36,
  },
  closeRight: {
    alignItems: "center",
    height: 36,
    justifyContent: "center",
    position: "absolute",
    right: 0,
    top: 0,
    width: 36,
  },
  closeText: { color: "#71717a", fontSize: 30, lineHeight: 32 },
  logoRow: { alignItems: "center", marginTop: 2 },
  logoRowTrial: { marginTop: 6 },
  logoWrap: { alignItems: "center", flexDirection: "row", gap: 7 },
  logoImage: { height: 30, resizeMode: "contain", width: 30 },
  logoMark: {
    backgroundColor: PURPLE,
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
    height: 30,
    lineHeight: 30,
    textAlign: "center",
    width: 30,
  },
  logoText: { color: PURPLE_DARK, fontSize: 22, fontWeight: "900" },
  proBadge: {
    backgroundColor: PURPLE,
    borderRadius: 999,
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  headline: {
    color: PURPLE_DARK,
    fontSize: 29,
    fontWeight: "900",
    letterSpacing: -1.2,
    lineHeight: 34,
    textAlign: "center",
  },
  subtitle: {
    alignSelf: "center",
    color: "#6f6878",
    fontSize: 14,
    lineHeight: 19,
    maxWidth: 310,
    textAlign: "center",
  },
  offerOuter: {
    backgroundColor: "#ffffff",
    borderColor: "#e6ddf8",
    borderRadius: 22,
    borderWidth: 1,
    marginHorizontal: 10,
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 20,
    shadowColor: PURPLE,
    shadowOpacity: 0.13,
    shadowRadius: 16,
  },
  offerOuterTrial: {
    marginTop: 10,
    paddingTop: 32,
  },
  ribbon: {
    alignSelf: "center",
    backgroundColor: GOLD,
    borderRadius: 6,
    paddingHorizontal: 18,
    paddingVertical: 6,
    position: "absolute",
    top: -12,
  },
  ribbonText: { color: "#ffffff", fontSize: 12, fontWeight: "900", letterSpacing: 0.7 },
  introMainPrice: { color: PURPLE_DARK, fontSize: 28, fontWeight: "900", textAlign: "center" },
  trialMainPrice: { color: PURPLE, fontSize: 32, fontWeight: "900", letterSpacing: -1.1, textAlign: "center" },
  offerSubtitle: { color: "#635e6d", fontSize: 16, fontWeight: "700", marginTop: 4, textAlign: "center" },
  monthlyChip: {
    alignSelf: "center",
    backgroundColor: LAVENDER,
    borderRadius: 999,
    marginTop: 10,
    paddingHorizontal: 18,
    paddingVertical: 7,
  },
  monthlyRow: { alignItems: "center", flexDirection: "row", gap: 14, justifyContent: "center", marginTop: 6 },
  monthlyText: { color: PURPLE, fontSize: 15, fontWeight: "900" },
  monthlyTextTrial: { color: PURPLE, fontSize: 19, fontWeight: "900" },
  originalPrice: { color: "#a8a0ad", fontSize: 16, textDecorationLine: "line-through" },
  socialPill: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e8e1f6",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 9,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  socialPillText: { color: PURPLE_DARK, fontSize: 15, fontWeight: "800" },
  creatorProof: { alignItems: "center", flexDirection: "row", gap: 10, justifyContent: "center", marginTop: 4 },
  creatorProofText: { color: "#635e6d", fontSize: 15 },
  creatorProofHighlight: { color: PURPLE, fontSize: 16, fontWeight: "900" },
  avatarStack: { alignItems: "center", flexDirection: "row" },
  avatar: { borderColor: "#ffffff", borderWidth: 2 },
  avatarFallback: { alignItems: "center", backgroundColor: "#d8caff", borderColor: "#ffffff", borderWidth: 2, justifyContent: "center" },
  avatarFallbackText: { color: PURPLE, fontSize: 10, fontWeight: "900" },
  avatarCount: { alignItems: "center", backgroundColor: PURPLE, borderColor: "#ffffff", borderWidth: 2, justifyContent: "center", paddingHorizontal: 3 },
  avatarCountText: { color: "#ffffff", fontSize: 9, fontWeight: "900" },
  featureCard: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    marginHorizontal: 8,
    padding: 10,
  },
  featureTitle: { color: PURPLE_DARK, fontSize: 16, fontWeight: "900", marginBottom: 5 },
  featureRow: { alignItems: "center", borderBottomColor: "#eeeaf4", borderBottomWidth: 1, flexDirection: "row", gap: 10, minHeight: 41 },
  featureIcon: { alignItems: "center", backgroundColor: LAVENDER, borderRadius: 9, height: 29, justifyContent: "center", width: 29 },
  featureIconText: { fontSize: 15 },
  featureText: { color: PURPLE_DARK, flex: 1, fontSize: 13, fontWeight: "700", lineHeight: 17 },
  chevronText: { color: PURPLE, fontSize: 26 },
  checkText: { color: GREEN, fontSize: 16 },
  testimonial: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#eeeaf4",
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    marginHorizontal: 8,
    padding: 10,
  },
  testimonialImage: { borderRadius: 25, height: 50, width: 50 },
  testimonialFallback: { alignItems: "center", backgroundColor: "#ded0ff", borderRadius: 25, height: 50, justifyContent: "center", width: 50 },
  testimonialFallbackText: { color: PURPLE, fontSize: 22, fontWeight: "900" },
  testimonialBody: { flex: 1 },
  testimonialHeader: { alignItems: "center", flexDirection: "row", gap: 5 },
  testimonialName: { color: PURPLE_DARK, fontSize: 14, fontWeight: "900" },
  testimonialFollowers: { color: "#918a98", fontSize: 11 },
  stars: { color: GOLD, fontSize: 11, marginTop: 2 },
  testimonialText: { color: PURPLE_DARK, fontSize: 13, lineHeight: 18, marginTop: 2 },
  trustBar: {
    alignItems: "center",
    borderColor: "#e9e2f4",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "center",
    marginHorizontal: 0,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  trustItem: { color: "#736d7c", flex: 1, fontSize: 10, textAlign: "center" },
  cta: {
    alignItems: "center",
    backgroundColor: PURPLE,
    borderRadius: 999,
    justifyContent: "center",
    marginHorizontal: 0,
    minHeight: 54,
    shadowColor: PURPLE,
    shadowOpacity: 0.22,
    shadowRadius: 14,
  },
  ctaText: { color: "#ffffff", fontSize: 20, fontWeight: "900" },
  trialLegal: { color: "#736d7c", fontSize: 12, textAlign: "center" },
  annualScreen: {
    backgroundColor: "#fbfaff",
    borderRadius: 28,
    gap: 12,
    paddingHorizontal: 8,
    paddingTop: 12,
  },
  annualClose: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 22,
    height: 36,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    top: 0,
    width: 36,
    zIndex: 2,
  },
  annualLogoRow: { alignItems: "center", flexDirection: "row", gap: 7, justifyContent: "center" },
  annualHeadline: {
    color: PURPLE_DARK,
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: -1.4,
    lineHeight: 38,
    textAlign: "center",
  },
  annualSubtitle: {
    alignSelf: "center",
    color: "#6f6878",
    fontSize: 15,
    lineHeight: 21,
    maxWidth: 320,
    textAlign: "center",
  },
  annualStatsRow: { flexDirection: "row", gap: 10, marginHorizontal: 12 },
  annualStatCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 12,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    shadowColor: PURPLE,
    shadowOpacity: 0.08,
    shadowRadius: 10,
  },
  annualStatIcon: { fontSize: 21 },
  annualStatValue: { color: PURPLE, fontSize: 16, fontWeight: "900" },
  annualStatLabel: { color: "#736d7c", fontSize: 10, fontWeight: "700" },
  annualOfferCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: PURPLE,
    borderRadius: 22,
    borderWidth: 1.5,
    marginHorizontal: 8,
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 22,
  },
  annualBadge: {
    alignSelf: "center",
    backgroundColor: "#f0c15a",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
    position: "absolute",
    top: -15,
  },
  annualBadgeText: { color: "#6f4e0f", fontSize: 13, fontWeight: "900" },
  annualPriceRow: { alignItems: "flex-end", flexDirection: "row", justifyContent: "center" },
  annualPrice: { color: PURPLE, fontSize: 58, fontWeight: "900", letterSpacing: -2.5, lineHeight: 64 },
  annualInterval: { color: PURPLE_DARK, fontSize: 21, fontWeight: "900", marginBottom: 9 },
  annualMonthly: { color: PURPLE, fontSize: 18, fontWeight: "900", marginTop: 2 },
  annualOriginal: { color: "#8b8492", fontSize: 17, marginTop: 2, textDecorationLine: "line-through" },
  annualBenefits: { flexDirection: "row", gap: 6, marginHorizontal: 6 },
  annualBenefitCard: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 14,
    flex: 1,
    minHeight: 132,
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
  annualBenefitIcon: { fontSize: 24, marginBottom: 8 },
  annualBenefitTitle: { color: PURPLE_DARK, fontSize: 17, fontWeight: "900", lineHeight: 20, textAlign: "center" },
  annualBenefitText: { color: "#736d7c", fontSize: 11, lineHeight: 15, marginTop: 8, textAlign: "center" },
  annualTestimonial: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#eeeaf4",
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    marginHorizontal: 6,
    padding: 10,
  },
  annualQuote: { color: PURPLE_DARK, fontSize: 14, fontStyle: "italic", fontWeight: "700", lineHeight: 20, marginTop: 4 },
  annualTrustBar: {
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderColor: "#e9e2f4",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "center",
    marginHorizontal: 6,
    paddingVertical: 9,
  },
  annualTrustItem: { color: "#4f4860", flex: 1, fontSize: 11, fontWeight: "700", textAlign: "center" },
});
