// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SearchListingCard } from "./SearchListingCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("~/hooks/use-storefront-url", () => ({ useStorefrontUrl: () => ({ storefrontUrl: "https://store.example" }) }));

it("removes editing on permission revocation without truncating saved search facts", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const props = { resource: "page" as const, value: { title: "A long saved title", description: "Full saved description.", handle: "saved-page", hidden: true }, onChange, fallbackTitle: "Page" };
  try {
    act(() => root.render(<SearchListingCard {...props} />));
    act(() => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(host.querySelector("input")).not.toBeNull();
    act(() => root.render(<SearchListingCard {...props} disabled />));
    expect(host.querySelector("input, textarea, button")).toBeNull();
    expect(host.textContent).toContain("A long saved title");
    expect(host.textContent).toContain("Full saved description.");
    expect(host.textContent).toContain("https://store.example/saved-page");
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
