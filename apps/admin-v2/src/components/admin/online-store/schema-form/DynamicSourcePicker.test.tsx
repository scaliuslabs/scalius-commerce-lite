// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { SettingBindings } from "@scalius/shared/storefront-theme/bindings";
import { DynamicSourcePicker } from "./DynamicSourcePicker";
import { DynamicSourceResource, SettingBindingScope } from "./binding-context";

const calls = vi.hoisted(() => ({ fields: vi.fn(async () => ({ definitions: [{ ownerType: "product", namespace: "custom", key: "material", name: "Material", type: "single_line_text", storefrontVisible: true }] })), objects: vi.fn(async () => []) }));
vi.mock("~/lib/api-query-options/custom-fields", () => ({ customFieldDefinitionsQueryOptions: () => ({ queryKey: ["fields"], queryFn: calls.fields }) }));
vi.mock("~/lib/api-query-options/objects", () => ({ objectTypesQueryOptions: () => ({ queryKey: ["objects"], queryFn: calls.objects }) }));
vi.mock("~/lib/api", () => ({ apiClient: {}, apiData: (value: unknown) => value }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Connect picker", () => {
  it("loads sources on demand, saves beside the fallback, and can disconnect", async () => {
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let latest: { settings: { heading: string }; bindings?: SettingBindings } = { settings: { heading: "Fallback heading" } };
    function Harness() {
      const [draft, setDraft] = useState(latest); latest = draft;
      return <DynamicSourceResource.Provider value="product"><SettingBindingScope bindings={draft.bindings} onChange={(bindings) => setDraft((current) => ({ ...current, bindings }))}>
        <p>{draft.settings.heading}</p><DynamicSourcePicker id="heading" path="heading" type="text" label="Heading" />
      </SettingBindingScope></DynamicSourceResource.Provider>;
    }
    try {
      act(() => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
      expect(calls.fields).not.toHaveBeenCalled();
      act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Use store data for Heading"]')!.click());
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(calls.fields).toHaveBeenCalledOnce();
      act(() => container.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("Material"));
      expect(option).toBeDefined();
      act(() => option!.click());
      expect(latest).toEqual({ settings: { heading: "Fallback heading" }, bindings: { heading: { source: "resource.cf.custom.material" } } });
      expect(container.textContent).toContain("Fallback heading");
      act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Disconnect")!.click());
      expect(latest.bindings).toBeUndefined();
      expect(latest.settings.heading).toBe("Fallback heading");
    } finally { act(() => root.unmount()); client.clear(); container.remove(); }
  });
});
