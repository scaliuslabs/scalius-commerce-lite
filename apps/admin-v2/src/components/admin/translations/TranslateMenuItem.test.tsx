// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const languages = vi.hoisted(() => ({ items: [] as Array<{ locale: string; isDefault: boolean }> }));
vi.mock("~/lib/api-query-options/translations", () => ({
  storeLanguagesQueryOptions: () => ({ queryKey: ["languages"], queryFn: async () => languages.items }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, search, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; search?: Record<string, string>; children: ReactNode }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} {...props}>{children}</a>
  ),
}));

import { DropdownMenu, DropdownMenuContent } from "~/components/ui/dropdown-menu";
import { useTranslateMenuItem } from "./TranslateMenuItem";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Menu({ id }: { id: string | undefined }) {
  const item = useTranslateMenuItem("product", id);
  return (
    <DropdownMenu open>
      <DropdownMenuContent>{item}</DropdownMenuContent>
    </DropdownMenu>
  );
}

let host: HTMLDivElement;
let root: Root;

async function render(id: string | undefined) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Menu id={id} />
      </QueryClientProvider>,
    ));
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("useTranslateMenuItem", () => {
  it("links to Translate & adapt on this item once the store has a second language", async () => {
    languages.items = [{ locale: "en", isDefault: true }, { locale: "bn", isDefault: false }];
    await render("prod_1");
    await vi.waitFor(() => expect(document.querySelector("a")).not.toBeNull());
    const link = document.querySelector("a");
    expect(link?.textContent).toBe("Translate");
    expect(link?.getAttribute("href")).toBe("/admin/translations?type=product&id=prod_1&locale=bn");
  });

  it("offers nothing for a one-language store or a new item", async () => {
    languages.items = [{ locale: "en", isDefault: true }];
    await render("prod_1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector("a")).toBeNull();
    languages.items = [{ locale: "en", isDefault: true }, { locale: "bn", isDefault: false }];
    await render(undefined);
    expect(document.querySelector("a")).toBeNull();
  });
});
