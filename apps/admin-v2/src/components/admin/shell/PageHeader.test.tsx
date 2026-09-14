// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageHeader, splitHeaderActions, type PageHeaderAction } from "./PageHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function action(id: string): PageHeaderAction {
  return { id, label: id, onClick: vi.fn() };
}

describe("splitHeaderActions", () => {
  it("keeps the first actions inline and overflows the rest", () => {
    const actions = [action("a"), action("b"), action("c")];
    expect(splitHeaderActions(actions, 2)).toEqual({
      inline: [actions[0], actions[1]],
      overflow: [actions[2]],
    });
    expect(splitHeaderActions(actions, 0)).toEqual({ inline: [], overflow: actions });
    expect(splitHeaderActions(actions, 5)).toEqual({ inline: actions, overflow: [] });
  });
});

describe("PageHeader", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  function buttons() {
    return Array.from(host.querySelectorAll("button"));
  }

  it("names the header with its title and renders the subtitle and breadcrumbs", async () => {
    await render(
      <PageHeader
        title="Delivery providers"
        subtitle="Connect a courier before shipping labels can be printed."
        breadcrumbs={[
          { label: "Settings", href: "/admin/settings" },
          { label: "Delivery providers" },
        ]}
      />,
    );

    const heading = host.querySelector("h1")!;
    expect(heading.textContent).toBe("Delivery providers");
    expect(host.querySelector('[data-testid="page-header"]')!.getAttribute("aria-labelledby"))
      .toBe(heading.id);
    expect(host.textContent).toContain("Connect a courier");

    const crumbLink = host.querySelector<HTMLAnchorElement>('nav[aria-label="Breadcrumb"] a')!;
    expect(crumbLink.getAttribute("href")).toBe("/admin/settings");
    expect(host.querySelector('[aria-current="page"]')!.textContent).toBe("Delivery providers");
  });

  it("renders no action area and no overflow trigger without actions", async () => {
    await render(<PageHeader title="Orders" />);

    expect(host.querySelector('[data-testid="page-header-actions"]')).toBeNull();
    expect(host.querySelector('[data-testid="page-header-overflow"]')).toBeNull();
  });

  it("renders a single primary action and fires it", async () => {
    const onClick = vi.fn();
    await render(
      <PageHeader title="Products" primaryAction={{ id: "add", label: "Add product", onClick }} />,
    );

    const primary = buttons().filter((item) => item.textContent?.trim() === "Add product");
    expect(primary).toHaveLength(1);
    await act(async () => primary[0].click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps secondary actions inline up to the limit and collapses the rest", async () => {
    await render(
      <PageHeader
        title="Products"
        secondaryActions={[action("Export"), action("Import"), action("Archive")]}
        primaryAction={{ id: "add", label: "Add product" }}
      />,
    );

    const inline = buttons().filter(
      (item) =>
        item.className.includes("hidden @lg:inline-flex") &&
        !item.dataset.testid?.startsWith("page-header-overflow"),
    );
    expect(inline.map((item) => item.textContent?.trim())).toEqual(["Export", "Import"]);

    // Narrow header: one menu holding every secondary action.
    const compact = host.querySelector<HTMLButtonElement>('[data-testid="page-header-overflow"]')!;
    expect(compact.getAttribute("aria-label")).toBe("More actions");
    expect(compact.className).toContain("@lg:hidden");

    // Wide header: a second trigger holding only what did not fit inline.
    const wide = host.querySelector<HTMLButtonElement>(
      '[data-testid="page-header-overflow-wide"]',
    )!;
    expect(wide.className).toContain("hidden @lg:inline-flex");
  });

  it("renders no wide overflow trigger when every action fits inline", async () => {
    await render(
      <PageHeader title="Products" secondaryActions={[action("Export")]} inlineActionCount={2} />,
    );

    const compact = host.querySelector<HTMLButtonElement>('[data-testid="page-header-overflow"]')!;
    // A narrow header keeps the menu (the inline buttons are hidden there).
    expect(compact.className).toContain("@lg:hidden");
    expect(host.querySelector('[data-testid="page-header-overflow-wide"]')).toBeNull();
  });

  it("wraps the actions onto their own line instead of squeezing the title", async () => {
    await render(
      <PageHeader
        title="Agent access"
        subtitle="Approve, scope, inspect, revoke, and clear every connection."
        primaryAction={{ id: "create", label: "Create token" }}
        secondaryActions={[action("Clear revoked (19)"), action("Revoke all")]}
      />,
    );

    // The header measures itself, not the viewport, so a 560px content column
    // collapses the actions the same way a 560px window would.
    const header = host.querySelector<HTMLElement>('[data-testid="page-header"]')!;
    expect(header.className).toContain("@container");

    const row = host.querySelector<HTMLElement>('[data-testid="page-header-row"]')!;
    expect(row.className).toContain("flex-wrap");

    const titleBlock = host.querySelector<HTMLElement>('[data-testid="page-header-title-block"]')!;
    expect(titleBlock.className).toContain("min-w-0");
    expect(titleBlock.className).toContain("flex-1");
    expect(titleBlock.className).toContain("basis-[16rem]");

    // The title wraps; it is never cut down to "Agent ac…".
    const heading = host.querySelector("h1")!;
    expect(heading.className).not.toContain("truncate");
    expect(heading.className).toContain("break-words");

    const actions = host.querySelector<HTMLElement>('[data-testid="page-header-actions"]')!;
    expect(actions.className).toContain("w-full");
    expect(actions.className).toContain("@md:w-auto");
  });

  it("renders the status slot under the title", async () => {
    await render(
      <PageHeader
        title="Taxes"
        status={<span data-testid="readiness">Tax calculation is off</span>}
      />,
    );

    const status = host.querySelector<HTMLElement>('[data-testid="page-header-status"]')!;
    expect(status.textContent).toContain("Tax calculation is off");
    // It belongs to the title block, not to the action area.
    expect(host.querySelector('[data-testid="page-header-actions"]')).toBeNull();
  });

  it("renders no status block without a status", async () => {
    await render(<PageHeader title="Taxes" />);
    expect(host.querySelector('[data-testid="page-header-status"]')).toBeNull();
  });

  it("swaps the title for an inline editor and keeps the header named", async () => {
    await render(
      <PageHeader
        title="Header primary"
        renderTitle={({ id, className, title }) => (
          <>
            <h1 id={id} className="sr-only">{title}</h1>
            <input aria-label="Menu name" defaultValue={title} className={className} />
          </>
        )}
        titleSlot={<button type="button">Rename</button>}
      />,
    );

    const heading = host.querySelector("h1")!;
    expect(heading.className).toBe("sr-only");
    expect(host.querySelector('[data-testid="page-header"]')!.getAttribute("aria-labelledby"))
      .toBe(heading.id);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Menu name"]')!.value)
      .toBe("Header primary");
    expect(host.textContent).toContain("Rename");
  });

  it("uses the supplied link component for breadcrumbs", async () => {
    function RouterLink({ href, children, className }: {
      href: string;
      children: ReactNode;
      className?: string;
    }) {
      return (
        <a data-router-link="true" href={href} className={className}>
          {children}
        </a>
      );
    }

    await render(
      <PageHeader
        title="Edit"
        linkComponent={RouterLink}
        breadcrumbs={[{ label: "Products", href: "/admin/products" }, { label: "Edit" }]}
      />,
    );

    expect(host.querySelector('a[data-router-link="true"]')?.getAttribute("href")).toBe(
      "/admin/products",
    );
  });
});
