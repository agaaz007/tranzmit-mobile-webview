import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";

let SafeAreaView: any = View;
try {
  SafeAreaView = require("react-native-safe-area-context").SafeAreaView || View;
} catch {
  SafeAreaView = View;
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
        <SafeAreaView style={fullscreen
          ? { flex: 1, backgroundColor: "#000" }
          : { flex: 1, justifyContent: "center", paddingHorizontal: 18, paddingVertical: 12 }}
        >
          {children}
        </SafeAreaView>
      </View>
    </Modal>
  );
}
