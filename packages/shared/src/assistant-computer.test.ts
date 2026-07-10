// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import {
  createScaliusBrowserComputerAdapter,
  normalizeScaliusComputerRoute,
  parseScaliusComputerProgram,
  SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT,
  ScaliusComputerController,
  type ScaliusComputerBinding,
  type ScaliusComputerPageAdapter,
  type ScaliusComputerPageSnapshot,
} from "./assistant-computer";

const binding: ScaliusComputerBinding = {
  surface: "storefront",
  threadId: "thread-1",
  tabId: "tab-1",
};

function snapshot(signature = "page-a"): ScaliusComputerPageSnapshot {
  return {
    route: "/products",
    title: "Products",
    signature,
    text: [{ role: "heading", name: "Products" }],
    targets: [
      { id: "search", role: "textbox", name: "Search", actions: ["fill"] },
      { id: "category", role: "combobox", name: "Category", actions: ["select"] },
      { id: "go", role: "button", name: "Search", actions: ["click"] },
    ],
  };
}

function adapter(overrides: Partial<ScaliusComputerPageAdapter> = {}): ScaliusComputerPageAdapter {
  return {
    capture: vi.fn(() => snapshot()),
    act: vi.fn(() => ({ ok: true as const })),
    goto: vi.fn(),
    refresh: vi.fn(),
    allowsRoute: vi.fn((route) => route.startsWith("/products")),
    isActive: vi.fn(() => true),
    ...overrides,
  };
}

describe("Scalius computer protocol", () => {
  it("parses strict quoted, revision-bound action batches", () => {
    expect(parseScaliusComputerProgram('fill @r2.e1 "red; shoe"; select @r2.e2 "Large"; click @r2.e3')).toEqual({
      ok: true,
      commands: [
        { name: "fill", handle: "@r2.e1", value: "red; shoe" },
        { name: "select", handle: "@r2.e2", value: "Large" },
        { name: "click", handle: "@r2.e3" },
      ],
    });
  });

  it.each([
    "query .danger",
    "click #save",
    "fill @r1.e1 unquoted",
    "observe; click @r1.e1",
    "click @r1.e1; click @r2.e1",
    "click @r1.e1; fill @r1.e2 \"later\"",
    "click @r1.e1; click @r1.e2",
    "goto https://evil.example",
  ])("rejects unsupported or ambiguous program %s", (program) => {
    expect(parseScaliusComputerProgram(program).ok).toBe(false);
  });

  it("accepts only path-shaped same-origin routes", () => {
    expect(normalizeScaliusComputerRoute("/search?q=red%20shoe#results")).toBe(
      "/search?q=red%20shoe#results",
    );
    expect(normalizeScaliusComputerRoute("https://evil.example/products")).toBeNull();
    expect(normalizeScaliusComputerRoute("//evil.example/products")).toBeNull();
    expect(normalizeScaliusComputerRoute("/%2f%2fevil.example")).toBeNull();
    expect(normalizeScaliusComputerRoute("/products\\evil")).toBeNull();
  });

  it("observes once, binds handles to the revision, and executes a batch", async () => {
    const page = adapter();
    const controller = new ScaliusComputerController({ binding, adapter: page });
    const observed = await controller.execute({ binding, program: "observe" });

    expect(observed).toMatchObject({ ok: true, code: "OBSERVED", revision: "r1" });
    expect(observed.output).toContain('@r1.e1 textbox "Search"');
    expect(observed.output).toContain("UNTRUSTED_PAGE_CONTENT");

    const result = await controller.execute({
      binding,
      program: 'fill @r1.e1 "boots"; select @r1.e2 "Shoes"; click @r1.e3',
    });
    expect(result).toMatchObject({ ok: true, code: "EXECUTED", changed: true });
    expect(page.act).toHaveBeenCalledTimes(3);
    expect(page.act).toHaveBeenNthCalledWith(1, { name: "fill", targetId: "search", value: "boots" });

    await expect(controller.execute({ binding, program: "click @r1.e3" })).resolves.toMatchObject({
      ok: false,
      code: "OBSERVE_REQUIRED",
    });
  });

  it("rejects cross-thread, cross-tab, inactive, and stale execution", async () => {
    let signature = "page-a";
    const page = adapter({ capture: vi.fn(() => snapshot(signature)) });
    const controller = new ScaliusComputerController({ binding, adapter: page });
    await controller.execute({ binding, program: "observe" });

    await expect(controller.execute({
      binding: { ...binding, threadId: "thread-2" },
      program: "click @r1.e3",
    })).resolves.toMatchObject({ ok: false, code: "INVALID_BINDING" });

    signature = "page-b";
    await expect(controller.execute({ binding, program: "click @r1.e3" })).resolves.toMatchObject({
      ok: false,
      code: "STALE_CONTEXT",
    });

    const inactive = new ScaliusComputerController({
      binding,
      adapter: adapter({ isActive: () => false }),
    });
    await expect(inactive.execute({ binding, program: "observe" })).resolves.toMatchObject({
      ok: false,
      code: "INACTIVE_TAB",
    });
  });

  it("keeps navigation surface-controlled and invalidates old page handles", async () => {
    const page = adapter();
    const controller = new ScaliusComputerController({ binding, adapter: page });
    await expect(controller.execute({ binding, program: 'goto "/products/shoes"' })).resolves.toMatchObject({
      ok: true,
      code: "NAVIGATED",
    });
    expect(page.goto).toHaveBeenCalledWith("/products/shoes");

    await expect(controller.execute({ binding, program: 'goto "/admin"' })).resolves.toMatchObject({
      ok: false,
      code: "ROUTE_BLOCKED",
    });
  });
});

function handleFor(output: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(@r\\d+\\.e\\d+) [^\\n]+ "${escaped}"`).exec(output);
  if (!match?.[1]) throw new Error(`Missing handle for ${label}: ${output}`);
  return match[1];
}

function browserController(overrides: {
  route?: string;
  allowsRoute?: (route: string) => boolean;
} = {}) {
  const goto = vi.fn();
  const refresh = vi.fn();
  const page = createScaliusBrowserComputerAdapter({
    document,
    origin: "https://shop.example",
    currentRoute: () => overrides.route ?? "/products",
    goto,
    refresh,
    allowsRoute: overrides.allowsRoute ?? ((route) => !route.startsWith("/admin")),
    isActive: () => true,
    textMode: "semantic",
  });
  return {
    controller: new ScaliusComputerController({ binding, adapter: page }),
    goto,
    refresh,
  };
}

describe("Scalius browser computer adapter", () => {
  it("emits a bounded accessibility snapshot without protected or implicit values", async () => {
    document.title = "Catalog";
    document.body.innerHTML = `
      <main>
        <h1>Products</h1>
        <p>Browse this season's shoes.</p>
        <label for="query">Search catalog</label>
        <input id="query" value="private draft" />
        <input aria-label="Public filter" value="red" data-scalius-computer-expose-value="true" />
        <a href="/products/red-shoe">Red shoe</a>
        <a href="https://evil.example/steal">External</a>
        <section data-scalius-computer-sensitive>
          <p>Customer phone 01700000000</p>
          <input aria-label="API token" value="sk-secret-value" />
        </section>
        <input type="password" aria-label="Password" value="never-show-me" />
        <button>Delete product</button>
        <div data-scalius-computer-exclude><button>Hidden agent control</button></div>
      </main>`;
    const { controller } = browserController();
    const result = await controller.execute({ binding, program: "observe" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('heading "Products"');
    expect(result.output).toContain('text "Browse this season\'s shoes."');
    expect(result.output).toContain('textbox "Search catalog"');
    expect(result.output).toContain('textbox "Public filter" [value="red"]');
    expect(result.output).toContain('link "Red shoe" route="/products/red-shoe"');
    expect(result.output).toContain('link "External" [human-only]');
    expect(result.output).toContain('textbox "Protected input" [sensitive]');
    expect(result.output).not.toContain("API token");
    expect(result.output).not.toContain("Password");
    expect(result.output).toContain('button "Delete product" [human-only]');
    expect(result.output).not.toContain("private draft");
    expect(result.output).not.toContain("01700000000");
    expect(result.output).not.toContain("sk-secret-value");
    expect(result.output).not.toContain("never-show-me");
    expect(result.output).not.toContain("Hidden agent control");
  });

  it("batches reversible drafts, revalidates stable targets, then performs one terminal click", async () => {
    document.body.innerHTML = `
      <main>
        <label for="query">Search</label><input id="query" />
        <label for="category">Category</label>
        <select id="category"><option value="all">All</option><option value="shoes">Shoes</option></select>
        <button data-scalius-computer-action="allow">Apply filters</button>
      </main>`;
    const input = document.querySelector("#query") as unknown as {
      value: string;
      addEventListener(type: string, listener: () => void): void;
    };
    const select = document.querySelector("#category") as unknown as { value: string };
    const button = document.querySelector("button") as unknown as {
      addEventListener(type: string, listener: () => void): void;
    };
    const inputEvents: string[] = [];
    input.addEventListener("input", () => inputEvents.push("input"));
    input.addEventListener("change", () => inputEvents.push("change"));
    const clicked = vi.fn();
    button.addEventListener("click", clicked);

    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    const fillHandle = handleFor(observed.output, "Search");
    const selectHandle = handleFor(observed.output, "Category");
    const clickHandle = handleFor(observed.output, "Apply filters");
    const result = await controller.execute({
      binding,
      program: `fill ${fillHandle} "boots"; select ${selectHandle} "Shoes"; click ${clickHandle}`,
    });

    expect(result).toMatchObject({ ok: true, code: "EXECUTED" });
    expect(input.value).toBe("boots");
    expect(inputEvents).toEqual(["input", "change"]);
    expect(select.value).toBe("shoes");
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("fills an explicitly bridged rich-text editor through one sanitizer-host event", async () => {
    document.body.innerHTML = `
      <main>
        <div data-scalius-computer-rich-text="sanitized-html">
          <div role="textbox" contenteditable="true" aria-label="Product description"></div>
        </div>
      </main>`;
    const bridge = document.querySelector<HTMLElement>(
      "[data-scalius-computer-rich-text]",
    )!;
    const accepted = vi.fn((event: Event) => {
      expect((event as CustomEvent<unknown>).detail).toBe(
        "<h2>Built for rain</h2><p><strong>Dry</strong> all day.</p>",
      );
      event.preventDefault();
    });
    bridge.addEventListener(SCALIUS_COMPUTER_RICH_TEXT_FILL_EVENT, accepted);

    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    const result = await controller.execute({
      binding,
      program:
        `fill ${handleFor(observed.output, "Product description")} "<h2>Built for rain</h2><p><strong>Dry</strong> all day.</p>"`,
    });

    expect(result).toMatchObject({ ok: true, code: "EXECUTED" });
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("fails closed when a rich-text marker has no accepting sanitizer bridge", async () => {
    document.body.innerHTML = `
      <main>
        <div data-scalius-computer-rich-text="sanitized-html">
          <div role="textbox" contenteditable="true" aria-label="Product description"></div>
        </div>
      </main>`;
    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });

    await expect(controller.execute({
      binding,
      program: `fill ${handleFor(observed.output, "Product description")} "unsafe"`,
    })).resolves.toMatchObject({ ok: false, code: "EXECUTION_FAILED" });
  });

  it("selects an exact accessible option from a portalled custom combobox", async () => {
    document.body.innerHTML = `
      <main>
        <button role="combobox" aria-label="Product category" aria-expanded="false">Choose</button>
      </main>`;
    const trigger = document.querySelector<HTMLButtonElement>("[role='combobox']")!;
    const selected = vi.fn();
    trigger.addEventListener("click", () => {
      if (document.querySelector("[role='option']")) {
        document.querySelector("[role='listbox']")?.remove();
        trigger.setAttribute("aria-expanded", "false");
        return;
      }
      trigger.setAttribute("aria-expanded", "true");
      const listbox = document.createElement("div");
      listbox.setAttribute("role", "listbox");
      listbox.innerHTML = `
        <button role="option" data-value="shoes">Shoes</button>
        <button role="option" data-value="shirts">Shirts</button>`;
      listbox.querySelector("[data-value='shoes']")?.addEventListener("click", () => {
        selected("shoes");
        trigger.textContent = "Shoes";
        listbox.remove();
        trigger.setAttribute("aria-expanded", "false");
      });
      document.body.appendChild(listbox);
    });

    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    const result = await controller.execute({
      binding,
      program: `select ${handleFor(observed.output, "Product category")} "Shoes"`,
    });

    expect(result).toMatchObject({ ok: true, code: "EXECUTED" });
    expect(selected).toHaveBeenCalledWith("shoes");
    expect(trigger.textContent).toBe("Shoes");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("requires explicit safe registration for submit and still blocks sensitive forms", async () => {
    document.body.innerHTML = `
      <main>
        <form id="safe" data-scalius-computer-submit="allow">
          <input aria-label="Query" /><button type="submit">Run search</button>
        </form>
        <form id="unsafe"><button type="submit">Save settings</button></form>
        <form id="sensitive" data-scalius-computer-submit="allow">
          <input type="password" /><button type="submit">Sign in</button>
        </form>
      </main>`;
    const safeSubmit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("#safe")!.addEventListener("submit", safeSubmit);
    const { controller } = browserController();

    let observed = await controller.execute({ binding, program: "observe" });
    await expect(controller.execute({
      binding,
      program: `submit ${handleFor(observed.output, "Run search")}`,
    })).resolves.toMatchObject({ ok: true, code: "EXECUTED" });
    expect(safeSubmit).toHaveBeenCalledOnce();

    observed = await controller.execute({ binding, program: "observe" });
    await expect(controller.execute({
      binding,
      program: `submit ${handleFor(observed.output, "Save settings")}`,
    })).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });

    observed = await controller.execute({ binding, program: "observe" });
    await expect(controller.execute({
      binding,
      program: `submit ${handleFor(observed.output, "Sign in")}`,
    })).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
  });

  it("rejects stale DOM handles before any action and keeps routes surface-scoped", async () => {
    document.body.innerHTML = '<main><button data-scalius-computer-action="allow">Continue</button></main>';
    const button = document.querySelector<HTMLButtonElement>("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const { controller, goto } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    const handle = handleFor(observed.output, "Continue");
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", "<h1>Changed</h1>");

    await expect(controller.execute({ binding, program: `click ${handle}` })).resolves.toMatchObject({
      ok: false,
      code: "STALE_CONTEXT",
    });
    expect(clicked).not.toHaveBeenCalled();
    await expect(controller.execute({ binding, program: 'goto "/search?q=boots"' })).resolves.toMatchObject({
      ok: true,
      code: "NAVIGATED",
    });
    expect(goto).toHaveBeenCalledWith("/search?q=boots");
    await expect(controller.execute({ binding, program: 'goto "/admin"' })).resolves.toMatchObject({
      ok: false,
      code: "ROUTE_BLOCKED",
    });
  });

  it.each([
    "Save changes",
    "Create product",
    "Update order",
    "Apply promotion",
    "Approve return",
    "Reject request",
    "Fulfill order",
    "Ship package",
    "Invite admin",
    "Enable gateway",
    "Disable provider",
    "Reset password",
  ])("keeps an unregistered consequential click human-only: %s", async (label) => {
    document.body.innerHTML = `<main><button>${label}</button></main>`;
    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    expect(observed.output).toContain(`button "${label}" [human-only]`);
    await expect(controller.execute({
      binding,
      program: `click ${handleFor(observed.output, label)}`,
    })).resolves.toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
  });

  it("allows the host to register a confirmed consequential click explicitly", async () => {
    document.body.innerHTML = '<main><button data-scalius-computer-action="allow">Save changes</button></main>';
    const button = document.querySelector("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    expect(observed.output).not.toContain('button "Save changes" [human-only]');
    await expect(controller.execute({
      binding,
      program: `click ${handleFor(observed.output, "Save changes")}`,
    })).resolves.toMatchObject({ ok: true, code: "EXECUTED" });
    expect(clicked).toHaveBeenCalledOnce();
  });
});
