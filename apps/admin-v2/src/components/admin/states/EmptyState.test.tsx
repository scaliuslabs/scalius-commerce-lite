// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "~/i18n";
import { statesMessages } from "~/i18n/states";
import { HELP_LINKS } from "~/lib/help-links";
import { EmptyState, FilteredEmptyState, SectionEmpty } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { OfflineBanner } from "./OfflineBanner";
import { ReadOnlyNotice } from "./ReadOnlyNotice";
import { PageSkeleton } from "./PageSkeleton";

vi.mock("./store-owner", () => ({ useStoreOwnerName: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setLocale("en");
});
const Icon = () => <svg />;
const render = (node: React.ReactNode) => act(() => root.render(node));
const slot = (name: string) => container.querySelector(`[data-slot=${name}]`);

describe("empty states (polish bar E1–E3)", () => {
  it("first use: one card with an action title, one sentence, the action and the help link", () => {
    render(<EmptyState icon={Icon} title="Add your first product" description="Products appear here." action={<button type="button">Add product</button>} />);
    expect(slot("empty-state")?.getAttribute("data-state-kind")).toBe("first-use");
    expect(container.querySelector("h2")?.textContent).toBe("Add your first product");
    expect(container.querySelector("button")?.textContent).toBe("Add product");
    const help = container.querySelector("a");
    expect(help?.getAttribute("href")).toBe(HELP_LINKS.questions);
    expect(help?.getAttribute("rel")).toContain("noopener");
    expect(help?.textContent).toBe(translate(statesMessages, "emptyHelp"));
  });

  it("filtered: names the miss and clears the filters", () => {
    const clear = vi.fn();
    render(<FilteredEmptyState title="No orders match these filters" onClearFilters={clear} />);
    expect(slot("empty-state")?.getAttribute("data-state-kind")).toBe("filtered");
    expect(container.querySelector("a")).toBeNull();
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Clear filters");
    act(() => button.click());
    expect(clear).toHaveBeenCalledOnce();
  });

  it("section: one muted line", () => {
    render(<SectionEmpty>No notes yet</SectionEmpty>);
    expect(slot("empty-state")?.textContent).toBe("No notes yet");
  });
});

describe("error states (R1, R3)", () => {
  it("says what failed and why, never 'Nothing changed', with Retry", () => {
    const retry = vi.fn();
    render(<ErrorState what="orders" error={new Error("boom")} onRetry={retry} />);
    expect(container.querySelector("h2")?.textContent).toBe("Couldn't load orders");
    expect(container.textContent).not.toContain("Nothing changed");
    expect(container.textContent).not.toContain("boom");
    act(() => container.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("shows the server's own reason for a refusal", () => {
    render(<ErrorState error={Object.assign(new Error("This order is being edited"), { status: 409 })} />);
    expect(container.textContent).toContain("This order is being edited");
  });

  it("inline: one line with Retry for one card of several", () => {
    render(<ErrorState layout="inline" title="Couldn't load shipments" onRetry={() => undefined} />);
    expect(slot("error-state")?.getAttribute("role")).toBe("alert");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("h1, h2")).toBeNull();
  });

  it("a deploy offers Reload, not Retry", () => {
    render(<ErrorState error={new TypeError("Failed to fetch dynamically imported module: /a.js")} onRetry={() => undefined} />);
    expect(container.querySelector("button")?.textContent).toBe("Reload");
  });
});

describe("offline, read-only and loading", () => {
  it("offline banner says the changes stay, and when a page waits for the connection", () => {
    render(<OfflineBanner />);
    expect(slot("offline-banner")?.textContent).toContain("Your changes stay here");
    render(<OfflineBanner waiting />);
    expect(slot("offline-banner")?.textContent).toContain("That page opens when you reconnect");
  });

  it("read-only notice names who can grant edit access", () => {
    render(<ReadOnlyNotice ownerName="Rahim" />);
    expect(slot("read-only-notice")?.textContent).toContain("Ask Rahim");
    setLocale("bn");
    render(<ReadOnlyNotice />);
    expect(slot("read-only-notice")?.textContent).toContain("স্টোরের মালিককে");
  });

  it("the skeleton keeps a known title and the page's columns", () => {
    render(<PageSkeleton kind="detail" title="Orders" main={[2, 2]} side={[1]} />);
    expect(slot("skeleton")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("h1")?.textContent).toBe("Orders");
    expect(container.querySelectorAll(".lg\\:col-span-2 > *")).toHaveLength(2);
  });
});
