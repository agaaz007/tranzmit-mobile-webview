import type { ReactNode } from "react";
import { Modal, Pressable, Text, View } from "react-native";

let SafeAreaView: any = View;
let useSafeAreaInsets: undefined | (() => { top: number; bottom: number; left: number; right: number });
try {
  const safeArea = require("react-native-safe-area-context");
  SafeAreaView = safeArea.SafeAreaView || View;
  useSafeAreaInsets = safeArea.useSafeAreaInsets;
} catch {
  SafeAreaView = View;
  useSafeAreaInsets = undefined;
}

export function ModalPresenter({
  visible,
  onDismiss,
  children,
  fullscreen = false,
}: {
  visible: boolean;
  onDismiss: () => void;
  children: ReactNode;
  fullscreen?: boolean;
}) {
  const insets = useSafeAreaInsets ? useSafeAreaInsets() : { top: 0, bottom: 0, left: 0, right: 0 };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <View style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss paywall backdrop"
          onPress={onDismiss}
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            bottom: 0,
            left: 0,
            position: "absolute",
            right: 0,
            top: 0,
          }}
        />
        {fullscreen ? (
          <View style={{ flex: 1, backgroundColor: "#000" }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss paywall"
              onPress={onDismiss}
              hitSlop={10}
              style={{
                alignItems: "center",
                backgroundColor: "transparent",
                borderRadius: 16,
                height: 32,
                justifyContent: "center",
                left: insets.left + 10,
                position: "absolute",
                top: insets.top + 6,
                width: 32,
                zIndex: 10,
              }}
            >
              <Text style={{ color: "rgba(110, 103, 131, 0.72)", fontSize: 22, lineHeight: 24, fontWeight: "300" }}>×</Text>
            </Pressable>
            {children}
          </View>
        ) : (
          <SafeAreaView style={{ flex: 1, justifyContent: "center", paddingHorizontal: 18, paddingVertical: 12 }}>
            <View style={{ alignSelf: "center", height: "90%", maxWidth: 440, width: "100%" }}>
              {children}
            </View>
          </SafeAreaView>
        )}
      </View>
    </Modal>
  );
}
