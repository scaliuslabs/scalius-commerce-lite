// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "~/i18n";
import { appSurfacesQueryOptions, type AppAdminSurfaces } from "~/lib/api-query-options/apps";
import { AppListFilter } from "./AppListFilter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/contexts/PermissionContext", () => ({ usePermissions: () => ({ hasPermission: () => true }) }));
vi.mock("@scalius/api-client/sdk", () => ({ getApiV1AdminAppsSurfaces: vi.fn() }));
vi.mock("~/lib/api", () => ({ apiData: () => new Promise(() => undefined) }));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", fmt: (amount: number) => String(amount) }) }));

type Column = AppAdminSurfaces["listColumns"][number];
const column = (id: string, type: Column["type"], filterable = true): Column => ({
  key: `scalius.loyalty/${id}`,
  id,
  resource: "customer",
  title: `Title ${id}`,
  type,
  filterable,
});

const APP = {
  id: "scalius.loyalty",
  name: "Loyalty",
  pages: [],
  cards: [],
  actions: [],
  widgets: [],
  listColumns: [column("tier", "text"), column("wallet", "money"), column("vip", "boolean"), column("hidden", "text", false)],
  routes: [],
  providers: [],
} as unknown as AppAdminSurfaces;

describe("AppListFilter", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onChange: ReturnType<typeof vi.fn<(value: string | undefined) => void>>;

  const render = async (value: string | undefined, labelled = false) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(appSurfacesQueryOptions().queryKey, [APP]);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AppListFilter resource="customer" value={value} onChange={onChange} labelled={labelled} />
        </QueryClientProvider>,
      );
    });
  };
  const input = () => container.querySelector<HTMLInputElement>("input");
  const type = (element: HTMLInputElement, text: string) => {
    // React tracks the value itself: set it through the native setter so the change event is seen.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(element, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = (element: HTMLElement, key: string) => act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

  beforeEach(() => {
    setLocale("en");
    onChange = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the column and value of the filter in the URL", async () => {
    await render("scalius.loyalty/tier:gold");
    expect(input()?.value).toBe("gold");
    expect(container.textContent).toContain("Title tier");
  });

  it("sets the filter when the value is entered, not on each keystroke", async () => {
    await render("scalius.loyalty/tier:gold");
    type(input()!, "silve");
    type(input()!, "silver");
    expect(onChange).not.toHaveBeenCalled();
    press(input()!, "Enter");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("scalius.loyalty/tier:silver");
  });

  it("sets the filter when the field is left, once", async () => {
    await render("scalius.loyalty/tier:gold");
    type(input()!, "bronze");
    act(() => input()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("scalius.loyalty/tier:bronze");
  });

  it("clears the filter when the value is emptied", async () => {
    await render("scalius.loyalty/tier:gold");
    type(input()!, "");
    press(input()!, "Enter");
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("keeps a value with colons whole", async () => {
    await render("scalius.loyalty/tier:a:b");
    expect(input()?.value).toBe("a:b");
    type(input()!, "c:d");
    press(input()!, "Enter");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("scalius.loyalty/tier:c:d");
  });

  it("filters money by an amount in the store currency, as the API takes it", async () => {
    await render("scalius.loyalty/wallet:12.5");
    expect(input()?.value).toBe("12.5");
    type(input()!, "20.75");
    press(input()!, "Enter");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("scalius.loyalty/wallet:20.75");
  });

  it("does not set a money filter that is not an amount", async () => {
    await render("scalius.loyalty/wallet:12.5");
    type(input()!, "lots");
    press(input()!, "Enter");
    expect(onChange).not.toHaveBeenCalled();
    expect(input()?.getAttribute("aria-invalid")).toBe("true");
  });

  it("offers Yes or No for a yes/no column, not a text field", async () => {
    await render("scalius.loyalty/vip:true");
    expect(input()).toBeNull();
    expect(container.textContent).toContain("Yes");
  });

  it("follows the URL when it changes from outside, such as Clear filters", async () => {
    await render("scalius.loyalty/tier:gold");
    await render(undefined);
    expect(input()?.value).toBe("");
    expect(input()?.disabled).toBe(true);
  });

  it("names the field above its controls only when asked", async () => {
    await render(undefined);
    expect(container.querySelector("label")).toBeNull();
    await render(undefined, true);
    expect(container.querySelector('[data-slot="field-label"]')?.textContent).toBe("App filter");
  });
});
