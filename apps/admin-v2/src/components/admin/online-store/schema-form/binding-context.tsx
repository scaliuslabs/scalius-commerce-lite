import { createContext, useContext, type ReactNode } from "react";
import type { SettingBindings } from "@scalius/shared/storefront-theme/bindings";
import type { SourceResource } from "./dynamic-sources";

export const DynamicSourceResource = createContext<SourceResource | null>(null);
export const BindingContext = createContext<{ bindings?: SettingBindings; pathPrefix?: string; onChange: (bindings: SettingBindings | undefined) => void } | null>(null);

export const useSettingBindings = () => useContext(BindingContext);

export function SettingBindingScope({ bindings, onChange, children, pathPrefix }: {
  bindings?: SettingBindings;
  pathPrefix?: string;
  onChange: (bindings: SettingBindings | undefined) => void;
  children: ReactNode;
}) {
  return <BindingContext.Provider value={{ bindings, onChange, pathPrefix }}>{children}</BindingContext.Provider>;
}
