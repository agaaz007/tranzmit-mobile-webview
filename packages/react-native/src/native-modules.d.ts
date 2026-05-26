declare module "react-native" {
  import type { ComponentType, ReactNode } from "react";

  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";

  export const AppState: {
    currentState: AppStateStatus;
    addEventListener(
      event: "change",
      cb: (state: AppStateStatus) => void
    ): { remove: () => void };
  };

  export const Platform: {
    OS: "ios" | "android" | "web" | "windows" | "macos" | string;
  };
  export const Linking: {
    openURL(url: string): Promise<unknown>;
  };

  export const Modal: ComponentType<any>;
  export const View: ComponentType<any>;
  export const Text: ComponentType<any>;
  export const Image: ComponentType<any>;
  export const ScrollView: ComponentType<any>;
  export const Pressable: ComponentType<any>;
  export const TouchableOpacity: ComponentType<any>;
  export const StyleSheet: {
    create<T extends Record<string, any>>(styles: T): T;
  };
  export const Dimensions: {
    get(name: "window" | "screen"): { width: number; height: number };
  };
  export const PixelRatio: {
    get(): number;
  };
  export function useWindowDimensions(): {
    width: number;
    height: number;
    scale: number;
    fontScale: number;
  };
  export interface LayoutChangeEvent {
    nativeEvent: {
      layout: {
        width: number;
        height: number;
      };
    };
  }
}

declare module "react-native-webview" {
  import type { ComponentType } from "react";

  export interface WebViewMessageEvent {
    nativeEvent: { data: string };
  }

  export interface WebViewNavigation {
    url: string;
  }

  const WebView: ComponentType<any>;
  export default WebView;
}

declare module "@react-native-async-storage/async-storage" {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  export default AsyncStorage;
}

declare module "expo-haptics" {
  export enum ImpactFeedbackStyle {
    Light = "light",
    Medium = "medium",
    Heavy = "heavy"
  }
  export function impactAsync(style: ImpactFeedbackStyle): Promise<void>;
}
