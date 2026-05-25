import React from "react";

type Listener = (state: string) => void;
const listeners = new Set<Listener>();

function host(tag: string) {
  return function HostComponent({ children, style: _style, ...props }: any) {
    const domProps = { ...props };
    delete domProps.accessibilityRole;
    delete domProps.accessibilityState;
    delete domProps.accessibilityLabel;
    delete domProps.resizeMode;
    delete domProps.source;
    delete domProps.bounces;
    delete domProps.contentContainerStyle;
    delete domProps.showsVerticalScrollIndicator;
    delete domProps.statusBarTranslucent;
    delete domProps.transparent;
    delete domProps.animationType;
    delete domProps.onRequestClose;
    if (domProps.onPress) {
      domProps.onClick = domProps.onPress;
      delete domProps.onPress;
    }
    return React.createElement(tag, domProps, children);
  };
}

export const AppState = {
  currentState: "active",
  addEventListener(_event: "change", cb: Listener) {
    listeners.add(cb);
    return { remove: () => listeners.delete(cb) };
  },
  __emit(state: string) {
    AppState.currentState = state;
    listeners.forEach((listener) => listener(state));
  },
  __reset() {
    AppState.currentState = "active";
    listeners.clear();
  },
};

export const Platform = { OS: "ios" };
export const Linking = { openURL: async (_url: string) => undefined };
export const View = host("div");
export const Text = host("span");
export const Image = host("img");
export const ScrollView = host("div");
export const Pressable = host("button");
export const TouchableOpacity = host("button");
export const Modal = ({ visible, children }: any) => (visible ? React.createElement("div", null, children) : null);
export const Dimensions = { get: () => ({ width: 390, height: 844 }) };
export const StyleSheet = { create: <T extends Record<string, any>>(styles: T) => styles };
