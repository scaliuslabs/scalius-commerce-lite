// @vitest-environment happy-dom

import { act, type AnchorHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, search, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; search?: Record<string, string>; children: ReactNode }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} {...props}>{children}</a>
  ),
}));

import { DropdownMenu, DropdownMenuContent } from "~/components/ui/dropdown-menu";
import { STORE_LANGUAGES_QUERY_KEY } from "~/lib/translation-types";
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
let client: QueryClient;

async function render(id: string | undefined) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Menu id={id} />
      </QueryClientProvider>,
    ));
}

beforeEach(() => {
  client = new QueryClient();
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
    client.setQueryData(STORE_LANGUAGES_QUERY_KEY, [{ locale: "en" }, { locale: "bn" }]);
    await render("prod_1");
    const link = document.querySelector("a");
    expect(link?.textContent).toBe("Translate");
    expect(link?.getAttribute("href")).toBe("/admin/translations?type=product&id=prod_1");
  });

  it("offers nothing for a one-language store or a new item", async () => {
    client.setQueryData(STORE_LANGUAGES_QUERY_KEY, [{ locale: "en" }]);
    await render("prod_1");
    expect(document.querySelector("a")).toBeNull();
    client.setQueryData(STORE_LANGUAGES_QUERY_KEY, [{ locale: "en" }, { locale: "bn" }]);
    await render(undefined);
    expect(document.querySelector("a")).toBeNull();
  });
});
