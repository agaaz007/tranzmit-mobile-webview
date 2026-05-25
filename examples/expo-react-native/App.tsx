import { useState } from "react";
import { Button, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { TranzmitPaywall, TranzmitProvider, useTranzmit } from "@tranzmit/react-native";

const PUBLIC_KEY = "pk_test_demo";
const TRIGGER = "upgrade_pro";

function DemoControls() {
  const { gate, isReady, reportConversion, track } = useTranzmit();
  const [showInline, setShowInline] = useState(false);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>Tranzmit Expo Testbed</Text>
        <Text style={styles.caption}>SDK ready: {isReady ? "yes" : "loading"}</Text>
        <Button
          title="Open paywall with gate()"
          disabled={!isReady}
          onPress={() => {
            const result = gate(TRIGGER, {
              presentation: "sheet",
              onCTA: (product) => {
                track("expo_demo_cta", { productId: product.id });
                reportConversion({
                  trigger: TRIGGER,
                  variantId: result.variantId,
                  productId: product.id,
                  revenue: product.price.amount / 100,
                  currency: product.price.currency,
                });
              },
            });
          }}
        />
        <Button
          title={showInline ? "Hide declarative paywall" : "Show declarative paywall"}
          disabled={!isReady}
          onPress={() => setShowInline((visible) => !visible)}
        />
      </View>
      <TranzmitPaywall
        trigger={TRIGGER}
        visible={showInline}
        presentation="inline"
        onCTA={(product) => {
          track("expo_demo_inline_cta", { productId: product.id });
          setShowInline(false);
        }}
        onDismiss={() => setShowInline(false)}
      />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <TranzmitProvider publicKey={PUBLIC_KEY} onError={(error) => console.warn("[Tranzmit]", error)}>
      <DemoControls />
    </TranzmitProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: 18,
    padding: 20,
  },
  card: {
    gap: 12,
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
  },
  caption: {
    color: "#6b7280",
  },
});
