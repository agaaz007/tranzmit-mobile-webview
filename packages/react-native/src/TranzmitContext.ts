import { createContext, useContext } from "react";
import type { TranzmitContextValue } from "./types.js";

export const TranzmitContext = createContext<TranzmitContextValue | null>(null);

export function useTranzmit(): TranzmitContextValue {
  const ctx = useContext(TranzmitContext);
  if (!ctx) {
    throw new Error("useTranzmit must be used within a TranzmitProvider");
  }
  return ctx;
}
