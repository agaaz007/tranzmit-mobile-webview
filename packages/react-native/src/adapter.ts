import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform, type AppStateStatus } from "react-native";
import type { PlatformAdapter, PlatformMetadata } from "@tranzmit/shared";
import { SDK_VERSION } from "./constants.js";

function isBackgroundState(state: AppStateStatus): boolean {
  return state === "background" || state === "inactive";
}

export const reactNativeAdapter: PlatformAdapter = {
  storage: {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: (key) => AsyncStorage.removeItem(key),
  },
  lifecycle: {
    onBackground(cb) {
      let lastState: AppStateStatus = AppState.currentState || "active";
      const subscription = AppState.addEventListener("change", (nextState) => {
        if (!isBackgroundState(lastState) && isBackgroundState(nextState)) {
          cb();
        }
        lastState = nextState;
      });
      return () => subscription.remove();
    },
    onForeground(cb) {
      let lastState: AppStateStatus = AppState.currentState || "active";
      const subscription = AppState.addEventListener("change", (nextState) => {
        if (isBackgroundState(lastState) && nextState === "active") {
          cb();
        }
        lastState = nextState;
      });
      return () => subscription.remove();
    },
  },
};

export const reactNativeMetadata: PlatformMetadata = {
  platform: "react-native",
  os: Platform.OS,
  sdkVersion: SDK_VERSION,
};
