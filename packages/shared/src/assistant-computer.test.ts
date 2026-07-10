// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import {
  createScaliusBrowserComputerAdapter,
  getScaliusComputerHumanConfirmationId,
  normalizeScaliusComputerRoute,
  parseScaliusComputerProgram,
  SCALIUS_COMPUTER_LIMITS,
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

  it("accepts one 4,000-character rich value inside the bounded program envelope", () => {
    const richValue = `<p>${"x".repeat(3_993)}</p>`;
    expect(richValue).toHaveLength(SCALIUS_COMPUTER_LIMITS.valueChars);
    expect(
      parseScaliusComputerProgram(
        `fill @r1.e1 ${JSON.stringify(richValue)}`,
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseScaliusComputerProgram(
        `fill @r1.e1 ${JSON.stringify(`${richValue}x`)}`,
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseScaliusComputerProgram(
        "x".repeat(SCALIUS_COMPUTER_LIMITS.programChars + 1),
      ),
    ).toMatchObject({ ok: false });
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
    await expect(controller.execute({
      binding,
      program: 'goto "/products/shoes"',
      authorizedNavigationRoutes: ["/products/shoes"],
    })).resolves.toMatchObject({
      ok: true,
      code: "NAVIGATED",
    });
    expect(page.goto).toHaveBeenCalledWith("/products/shoes");

    await expect(controller.execute({
      binding,
      program: 'goto "/admin"',
      authorizedNavigationRoutes: ["/admin"],
    })).resolves.toMatchObject({
      ok: false,
      code: "ROUTE_BLOCKED",
    });

    await expect(controller.execute({
      binding,
      program: 'goto "/products/shoes"',
    })).resolves.toMatchObject({
      ok: false,
      code: "ROUTE_BLOCKED",
    });
  });

  it("binds a visible link click to one trusted exact route", async () => {
    const page = adapter({
      capture: vi.fn(() => ({
        ...snapshot(),
        targets: [
          {
            id: "products-link",
            role: "link",
            name: "Products",
            actions: ["click"] as const,
            route: "/products",
          },
        ],
      })),
    });
    const controller = new ScaliusComputerController({ binding, adapter: page });
    await controller.execute({ binding, program: "observe" });

    await expect(controller.execute({
      binding,
      program: "click @r1.e1",
    })).resolves.toMatchObject({ ok: false, code: "ROUTE_BLOCKED" });
    expect(page.act).not.toHaveBeenCalled();

    await expect(controller.execute({
      binding,
      program: "click @r1.e1",
      authorizedNavigationRoutes: ["/products"],
    })).resolves.toMatchObject({ ok: true, code: "EXECUTED" });
    expect(page.act).toHaveBeenCalledOnce();
  });
});

function handleFor(output: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(@r\\d+\\.e\\d+) [^\\n]+ "${escaped}"`).exec(output);
  if (!match?.[1]) throw new Error(`Missing handle for ${label}: ${output}`);
  return match[1];
}

function browserController(overrides: {
  route?: string | (() => string);
  allowsRoute?: (route: string) => boolean;
  confirmationNow?: () => number;
  confirmationTtlMs?: number;
  createConfirmationToken?: () => string;
} = {}) {
  const goto = vi.fn();
  const refresh = vi.fn();
  const page = createScaliusBrowserComputerAdapter({
    document,
    origin: "https://shop.example",
    currentRoute: () =>
      typeof overrides.route === "function"
        ? overrides.route()
        : overrides.route ?? "/products",
    goto,
    refresh,
    allowsRoute: overrides.allowsRoute ?? ((route) => !route.startsWith("/admin")),
    isActive: () => true,
    textMode: "semantic",
  });
  return {
    controller: new ScaliusComputerController({
      binding,
      adapter: page,
      confirmationNow: overrides.confirmationNow,
      confirmationTtlMs: overrides.confirmationTtlMs,
      createConfirmationToken: overrides.createConfirmationToken,
    }),
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
    await expect(controller.execute({
      binding,
      program: 'goto "/search?q=boots"',
      authorizedNavigationRoutes: ["/search?q=boots"],
    })).resolves.toMatchObject({
      ok: true,
      code: "NAVIGATED",
    });
    expect(goto).toHaveBeenCalledWith("/search?q=boots");
    await expect(controller.execute({
      binding,
      program: 'goto "/admin"',
      authorizedNavigationRoutes: ["/admin"],
    })).resolves.toMatchObject({
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

  it("returns only an app-owned human confirmation ID without clicking the control", async () => {
    document.body.innerHTML = `
      <main>
        <button
          data-scalius-computer-human-only
          data-scalius-computer-human-confirmation="admin.media.image.generate"
        >Generate image</button>
      </main>`;
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    const result = await controller.execute({
      binding,
      program: `click ${handleFor(observed.output, "Generate image")}`,
    });

    expect(result).toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(getScaliusComputerHumanConfirmationId(result)).toBe(
      "admin.media.image.generate",
    );
    expect(clicked).not.toHaveBeenCalled();
  });

  it("refuses to defer an ambiguous duplicated app action ID", async () => {
    document.body.innerHTML = `
      <main>
        <button data-scalius-computer-human-confirmation="admin.media.image.generate.library-page">Generate first</button>
        <button data-scalius-computer-human-confirmation="admin.media.image.generate.library-page">Generate second</button>
      </main>`;
    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    const result = await controller.execute({
      binding,
      program: `click ${handleFor(observed.output, "Generate first")}`,
    });

    expect(result).toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(getScaliusComputerHumanConfirmationId(result)).toBeNull();
  });

  it("never arms human confirmation for an already disabled operation", async () => {
    document.body.innerHTML = `
      <main>
        <button disabled data-scalius-computer-human-confirmation="admin.media.image.generate.library-page.panel-a">Generating image</button>
      </main>`;
    const { controller } = browserController();
    const observed = await controller.execute({ binding, program: "observe" });
    const result = await controller.execute({
      binding,
      program: `click ${handleFor(observed.output, "Generating image")}`,
    });

    expect(result).toMatchObject({ ok: false, code: "TARGET_DISABLED" });
    expect(getScaliusComputerHumanConfirmationId(result)).toBeNull();
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

const CONFIRMATION_TOKEN = "confirmation_token_1234567890abcdef";

async function armBrowserConfirmation(
  controller: ScaliusComputerController,
  label: string,
  action: "click" | "submit" = "click",
  confirmationExpiresAt?: number,
) {
  const observed = await controller.execute({ binding, program: "observe" });
  const result = await controller.execute({
    binding,
    program: `${action} ${handleFor(observed.output, label)}`,
    ...(confirmationExpiresAt === undefined ? {} : { confirmationExpiresAt }),
  });
  expect(result).toEqual({
    ok: false,
    code: "CONFIRMATION_REQUIRED",
    output: "This exact page action is waiting for direct human confirmation.",
    retryable: false,
  });
  const serializedResult = JSON.stringify(result);
  expect(serializedResult).not.toContain(CONFIRMATION_TOKEN);
  expect(serializedResult).not.toContain("/products");
  expect(serializedResult).not.toContain("dom-");
  const pending = controller.getPendingConfirmation();
  expect(pending).not.toBeNull();
  return pending!;
}

describe("Scalius generic exact-target confirmations", () => {
  it("creates a fresh opaque crypto token for each local confirmation", async () => {
    document.body.innerHTML = `
      <main><button data-scalius-computer-confirm="required">Save product</button></main>`;
    const { controller } = browserController();

    const first = await armBrowserConfirmation(controller, "Save product");
    expect(first.token).toMatch(/^[a-f0-9]{48}$/u);
    controller.cancelPendingConfirmation({ binding, token: first.token });

    const second = await armBrowserConfirmation(controller, "Save product");
    expect(second.token).toMatch(/^[a-f0-9]{48}$/u);
    expect(second.token).not.toBe(first.token);
  });

  it("confirms an exact click once without serializing local capability data", async () => {
    document.body.innerHTML = `
      <main>
        <button data-scalius-computer-confirm="required">Save changes</button>
      </main>`;
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });

    const pending = await armBrowserConfirmation(controller, "Save changes");
    expect(pending).toMatchObject({
      token: CONFIRMATION_TOKEN,
      binding,
      route: "/products",
      revision: "r1",
      action: "click",
      expiresAt: expect.any(Number),
    });
    expect(pending.snapshotSignature).toMatch(/^[a-z0-9]+$/u);
    expect(pending.targetId).toMatch(/^dom-\d+$/u);
    expect(pending.targetFingerprint).toMatch(/^[a-z0-9.]+$/u);
    expect(clicked).not.toHaveBeenCalled();

    await expect(controller.confirmPendingConfirmation({
      binding,
      token: pending.token,
    })).resolves.toEqual({
      ok: true,
      code: "CONFIRMED",
      output: "Completed the confirmed page action.",
      changed: true,
    });
    expect(clicked).toHaveBeenCalledOnce();
    expect(controller.getPendingConfirmation()).toBeNull();

    await expect(controller.confirmPendingConfirmation({
      binding,
      token: pending.token,
    })).resolves.toMatchObject({
      ok: false,
      code: "CONFIRMATION_NOT_FOUND",
    });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("confirms an explicitly marked submit exactly once", async () => {
    document.body.innerHTML = `
      <main>
        <form data-scalius-computer-confirm="required">
          <input aria-label="Public query" />
          <button type="submit">Create report</button>
        </form>
      </main>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });

    const pending = await armBrowserConfirmation(
      controller,
      "Create report",
      "submit",
    );
    expect(submitted).not.toHaveBeenCalled();
    await controller.confirmPendingConfirmation({ binding, token: pending.token });
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("keeps one pending slot and does not expose it through another execution", async () => {
    document.body.innerHTML = `
      <main>
        <button data-scalius-computer-confirm="required">Publish product</button>
      </main>`;
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const pending = await armBrowserConfirmation(controller, "Publish product");

    const blocked = await controller.execute({ binding, program: "observe" });
    expect(blocked).toEqual({
      ok: false,
      code: "BUSY",
      output: "Resolve the pending human confirmation before another page command.",
      retryable: false,
    });
    expect(JSON.stringify(blocked)).not.toContain(pending.token);
    expect(JSON.stringify(blocked)).not.toContain(pending.targetId);
    expect(JSON.stringify(blocked)).not.toContain(pending.route);
  });

  it("rejects a token mismatch without burning the valid local confirmation", async () => {
    document.body.innerHTML = `
      <main><button data-scalius-computer-confirm="required">Save product</button></main>`;
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const pending = await armBrowserConfirmation(controller, "Save product");

    await expect(controller.confirmPendingConfirmation({
      binding,
      token: "incorrect_token_1234567890abcdef",
    })).resolves.toMatchObject({
      ok: false,
      code: "CONFIRMATION_NOT_FOUND",
    });
    expect(clicked).not.toHaveBeenCalled();
    expect(controller.getPendingConfirmation()).toEqual(pending);

    await controller.confirmPendingConfirmation({ binding, token: pending.token });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("rejects a cross-thread confirmation without burning the bound one", async () => {
    document.body.innerHTML = `
      <main><button data-scalius-computer-confirm="required">Save product</button></main>`;
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const pending = await armBrowserConfirmation(controller, "Save product");

    await expect(controller.confirmPendingConfirmation({
      binding: { ...binding, threadId: "thread-2" },
      token: pending.token,
    })).resolves.toMatchObject({ ok: false, code: "INVALID_BINDING" });
    expect(clicked).not.toHaveBeenCalled();

    await controller.confirmPendingConfirmation({ binding, token: pending.token });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("burns a cancelled confirmation and never performs its action", async () => {
    document.body.innerHTML = `
      <main><button data-scalius-computer-confirm="required">Save product</button></main>`;
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const pending = await armBrowserConfirmation(controller, "Save product");

    expect(controller.cancelPendingConfirmation({
      binding,
      token: pending.token,
    })).toMatchObject({ ok: true, code: "CANCELLED", changed: false });
    await expect(controller.confirmPendingConfirmation({
      binding,
      token: pending.token,
    })).resolves.toMatchObject({
      ok: false,
      code: "CONFIRMATION_NOT_FOUND",
    });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("uses the earlier trusted expiry and burns an expired confirmation", async () => {
    let now = 10_000;
    document.body.innerHTML = `
      <main><button data-scalius-computer-confirm="required">Save product</button></main>`;
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const { controller } = browserController({
      confirmationNow: () => now,
      confirmationTtlMs: 60_000,
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const pending = await armBrowserConfirmation(
      controller,
      "Save product",
      "click",
      12_000,
    );
    expect(pending.expiresAt).toBe(12_000);
    now = 12_000;

    await expect(controller.confirmPendingConfirmation({
      binding,
      token: pending.token,
    })).resolves.toMatchObject({
      ok: false,
      code: "CONFIRMATION_EXPIRED",
    });
    await expect(controller.confirmPendingConfirmation({
      binding,
      token: pending.token,
    })).resolves.toMatchObject({
      ok: false,
      code: "CONFIRMATION_NOT_FOUND",
    });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("allows only one side effect across concurrent duplicate confirmations", async () => {
    document.body.innerHTML = `
      <main><button data-scalius-computer-confirm="required">Save product</button></main>`;
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const pending = await armBrowserConfirmation(controller, "Save product");

    const results = await Promise.all([
      controller.confirmPendingConfirmation({ binding, token: pending.token }),
      controller.confirmPendingConfirmation({ binding, token: pending.token }),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([
      "CONFIRMATION_NOT_FOUND",
      "CONFIRMED",
    ]);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "route",
      mutate: (button: HTMLButtonElement, setRoute: (route: string) => void) =>
        setRoute("/products/changed"),
      code: "STALE_CONTEXT",
    },
    {
      name: "snapshot signature",
      mutate: () =>
        document.querySelector("main")!.insertAdjacentHTML("afterbegin", "<h1>Changed</h1>"),
      code: "STALE_CONTEXT",
    },
    {
      name: "exact target",
      mutate: (button: HTMLButtonElement) => button.replaceWith(button.cloneNode(true)),
      code: "TARGET_GONE",
    },
    {
      name: "accessible label",
      mutate: (button: HTMLButtonElement) => {
        button.textContent = "Save changed product";
      },
      code: "STALE_CONTEXT",
    },
    {
      name: "action",
      mutate: (button: HTMLButtonElement) => button.setAttribute("role", "textbox"),
      code: "ACTION_NOT_ALLOWED",
    },
    {
      name: "state",
      mutate: (button: HTMLButtonElement) => button.setAttribute("aria-expanded", "true"),
      code: "STALE_CONTEXT",
    },
    {
      name: "disabled state",
      mutate: (button: HTMLButtonElement) => {
        button.disabled = true;
      },
      code: "TARGET_DISABLED",
    },
    {
      name: "sensitive state",
      mutate: (button: HTMLButtonElement) =>
        button.setAttribute("data-scalius-computer-sensitive", ""),
      code: "SENSITIVE_CONTROL",
    },
  ])("fails closed when the confirmed control's $name changes", async ({ mutate, code }) => {
    let route = "/products";
    document.body.innerHTML = `
      <main><button data-scalius-computer-confirm="required">Save product</button></main>`;
    const button = document.querySelector<HTMLButtonElement>("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    const { controller } = browserController({
      route: () => route,
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const pending = await armBrowserConfirmation(controller, "Save product");
    mutate(button, (nextRoute) => {
      route = nextRoute;
    });

    await expect(controller.confirmPendingConfirmation({
      binding,
      token: pending.token,
    })).resolves.toMatchObject({ ok: false, code });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("never converts specialized or permanently human-only controls into generic confirmations", async () => {
    document.body.innerHTML = `
      <main>
        <button
          data-scalius-computer-confirm="required"
          data-scalius-computer-human-confirmation="admin.media.image.generate"
        >Generate image</button>
        <button
          data-scalius-computer-confirm="required"
          data-scalius-computer-human-only
        >Delete permanently</button>
      </main>`;
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    let observed = await controller.execute({ binding, program: "observe" });
    let result = await controller.execute({
      binding,
      program: `click ${handleFor(observed.output, "Generate image")}`,
    });
    expect(result).toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(getScaliusComputerHumanConfirmationId(result)).toBe(
      "admin.media.image.generate",
    );
    expect(controller.getPendingConfirmation()).toBeNull();

    observed = await controller.execute({ binding, program: "observe" });
    result = await controller.execute({
      binding,
      program: `click ${handleFor(observed.output, "Delete permanently")}`,
    });
    expect(result).toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(controller.getPendingConfirmation()).toBeNull();
  });

  it("never arms a generic confirmation for a credential-hint form", async () => {
    document.body.innerHTML = `
      <main>
        <form data-scalius-computer-confirm="required">
          <input type="text" name="apiKey" />
          <button type="submit">Save provider</button>
        </form>
      </main>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const observed = await controller.execute({ binding, program: "observe" });
    const result = await controller.execute({
      binding,
      program: `submit ${handleFor(observed.output, "Save provider")}`,
    });

    expect(result).toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(controller.getPendingConfirmation()).toBeNull();
    expect(submitted).not.toHaveBeenCalled();
  });

  it("fails closed when any bounded form descendant is sensitive", async () => {
    document.body.innerHTML = `
      <main>
        <form data-scalius-computer-confirm="required">
          <div name="privateTokenMetadata"></div>
          <button type="submit">Save integration</button>
        </form>
      </main>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const observed = await controller.execute({ binding, program: "observe" });
    const result = await controller.execute({
      binding,
      program: `submit ${handleFor(observed.output, "Save integration")}`,
    });

    expect(result).toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(controller.getPendingConfirmation()).toBeNull();
    expect(submitted).not.toHaveBeenCalled();
  });

  it("fails closed instead of scanning an oversized confirmation form", async () => {
    document.body.innerHTML = `
      <main>
        <form data-scalius-computer-confirm="required">
          ${"<span></span>".repeat(201)}
          <button type="submit">Save oversized form</button>
        </form>
      </main>`;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submitted);
    const { controller } = browserController({
      createConfirmationToken: () => CONFIRMATION_TOKEN,
    });
    const observed = await controller.execute({ binding, program: "observe" });
    const result = await controller.execute({
      binding,
      program: `submit ${handleFor(observed.output, "Save oversized form")}`,
    });

    expect(result).toMatchObject({ ok: false, code: "HUMAN_REQUIRED" });
    expect(controller.getPendingConfirmation()).toBeNull();
    expect(submitted).not.toHaveBeenCalled();
  });
});
