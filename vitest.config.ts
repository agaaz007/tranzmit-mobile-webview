import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const rnMock = fileURLToPath(new URL("./packages/react-native/tests/mocks/react-native.ts", import.meta.url));
const asyncStorageMock = fileURLToPath(new URL("./packages/react-native/tests/mocks/async-storage.ts", import.meta.url));
const rnWebViewMock = fileURLToPath(new URL("./packages/react-native/tests/mocks/react-native-webview.tsx", import.meta.url));
const sharedEntry = fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "react-native": rnMock,
      "@react-native-async-storage/async-storage": asyncStorageMock,
      "react-native-webview": rnWebViewMock,
      "@tranzmit/shared": sharedEntry,
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["packages/*/tests/**/*.test.ts", "packages/*/tests/**/*.test.tsx"],
  },
});
