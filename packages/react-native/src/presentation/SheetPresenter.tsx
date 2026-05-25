import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";

let BottomSheet: any = null;
try {
  BottomSheet = require("@gorhom/bottom-sheet").default;
} catch {
  BottomSheet = null;
}

export function SheetPresenter({
  visible,
  onDismiss,
  children,
}: {
  visible: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  if (BottomSheet) {
    return (
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss} statusBarTranslucent>
        <View style={{ flex: 1 }}>
          <Pressable
            onPress={onDismiss}
            style={{
              backgroundColor: "rgba(0, 0, 0, 0.45)",
              bottom: 0,
              left: 0,
              position: "absolute",
              right: 0,
              top: 0,
            }}
          />
          <BottomSheet
            enablePanDownToClose
            index={0}
            onClose={onDismiss}
            snapPoints={["60%", "90%"]}
          >
            <View style={{ paddingHorizontal: 16, paddingBottom: 20 }}>{children}</View>
          </BottomSheet>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss paywall backdrop"
          onPress={onDismiss}
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.45)",
            bottom: 0,
            left: 0,
            position: "absolute",
            right: 0,
            top: 0,
          }}
        />
        <View style={{ padding: 12 }}>{children}</View>
      </View>
    </Modal>
  );
}
