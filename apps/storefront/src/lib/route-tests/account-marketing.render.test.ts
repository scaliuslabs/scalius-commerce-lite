// @vitest-environment node
/**
 * Account → Profile → News and offers against a stubbed API (Astro container
 * API through a Vite dev server in middleware mode): one box per channel the
 * account has an address for, in the store's language; a plain form post
 * sends only the channels the buyer changed and lands back with an outcome
 * flag, never a contact, in the URL.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { Window } from "happy-dom";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const VIRTUAL_MODULES: Record<string, string> = {
  "cloudflare:workers": "export const env = {}; export class WorkerEntrypoint {};",
  "astro:react:opts": "export default {};",
  "virtual:scalius/partytown": 'export const partytownLoaderPath = "/~partytown/partytown.js";',
};
const API = "https://api.shop.test/api/v1";
const SESSION = "cs_tok=session-token-value; cs_auth=1";

interface Container {
  renderToString(component: unknown, options: { request?: Request; props?: object; slots?: Record<string, string> }): Promise<string>;
  renderToResponse(component: unknown, options: { request?: Request; locals?: object; props?: object; slots?: Record<string, string> }): Promise<Response>;
}
interface RuntimeModule {
  requestRuntime: { run<T>(runtime: object, task: () => T): T };
}

let server: ViteDevServer;
let container: Container;
let ProfilePage: unknown;
let AccountShell: unknown;
let runtimeModule: RuntimeModule;

beforeAll(async () => {
  const { getViteConfig } = await import("astro/config");
  const { createServer } = await import("vite");
  const configure = getViteConfig(
    {
      root,
      logLevel: "error",
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "custom",
      plugins: [
        {
          name: "account-marketing-test-virtual-modules",
          resolveId: (id: string) => (id in VIRTUAL_MODULES ? `\0account-marketing-test:${id}` : undefined),
          load: (id: string) =>
            id.startsWith("\0account-marketing-test:") ? VIRTUAL_MODULES[id.slice("\0account-marketing-test:".length)] : undefined,
        },
      ],
    } as never,
    { configFile: false, root, logLevel: "error", devToolbar: { enabled: false } } as never,
  ) as unknown as (env: { mode: string; command: string }) => Promise<object>;
  server = await createServer({ ...(await configure({ mode: "test", command: "serve" })), configFile: false });
  const { experimental_AstroContainer } = await server.ssrLoadModule("astro/container");
  const reactRenderer = (await server.ssrLoadModule("@astrojs/react/server.js")).default;
  container = await experimental_AstroContainer.create();
  (container as unknown as { addServerRenderer(renderer: object): void }).addServerRenderer({
    name: "@astrojs/react",
    renderer: reactRenderer,
  });
  ProfilePage = (await server.ssrLoadModule("/src/pages/account/profile.astro")).default;
  AccountShell = (await server.ssrLoadModule("/src/components/account/AccountShell.astro")).default;
  runtimeModule = (await server.ssrLoadModule("/src/lib/api/runtime.ts")) as RuntimeModule;
}, 120_000);

afterAll(async () => {
  await server?.close();
});

let window = new Window();
afterEach(async () => {
  vi.unstubAllGlobals();
  const previous = window;
  window = new Window();
  await previous.happyDOM.close();
});
const parse = (html: string) => new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, " ").trim() ?? "";

const envelope = (data: unknown) => JSON.stringify({ success: true, data });
const CUSTOMER = { id: "cust_1", name: "Rina Akter", email: null, phone: "+8801712345678", address: null, city: null, zone: null, area: null };
const CHANNELS = [
  { channel: "email", status: "not_subscribed", available: false },
  { channel: "sms", status: "subscribed", available: true },
  { channel: "whatsapp", status: "not_subscribed", available: true },
  { channel: "push", status: "not_subscribed", available: true },
];

interface Put {
  path: string;
  body: unknown;
}

function stubApi(languageCode = "en") {
  const puts: Put[] = [];
  const answer = (path: string, method: string, body: unknown): { status: number; body: string } => {
    if (path === "/api/v1/storefront/layout") {
      return { status: 200, body: envelope({ analytics: [], navigation: [], footerMenus: [], policies: [], currency: { code: "BDT", symbol: "৳", decimalPlaces: 0 }, storefrontCopy: { languageCode } }) };
    }
    if (path === "/api/v1/customer-auth/me") return { status: 200, body: envelope({ authenticated: true, customer: CUSTOMER }) };
    if (path === "/api/v1/customer-auth/marketing" && method === "GET") return { status: 200, body: envelope({ channels: CHANNELS }) };
    if (path === "/api/v1/customer-auth/marketing" && method === "PUT") {
      puts.push({ path, body });
      return { status: 200, body: envelope({ channels: CHANNELS, confirmationRequested: false }) };
    }
    if (path === "/api/v1/locations/cities") return { status: 200, body: envelope([]) };
    return { status: 404, body: "{}" };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname === "/api/v1/storefront/batch") {
      const parts = url.searchParams.getAll("r").map((part) => {
        const { status, body } = answer(new URL(part, url.origin).pathname, "GET", null);
        return { status, body, contentType: "application/json" };
      });
      return new Response(envelope({ parts }), { headers: { "Content-Type": "application/json" } });
    }
    const { status, body } = answer(url.pathname, method, init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }));
  return puts;
}

async function renderProfile(request: Request) {
  const runtime = { PUBLIC_API_URL: API, PUBLIC_API_BASE_URL: "https://api.shop.test", inflightReads: new Map() };
  return runtimeModule.requestRuntime.run(runtime, () => container.renderToResponse(ProfilePage, { request, locals: {} }));
}

describe("account news and offers", () => {
  it("shows a box per channel, ticked as subscribed, and explains a channel without an address", async () => {
    stubApi();
    const page = parse(await (await renderProfile(new Request("https://shop.test/account/profile", { headers: { Cookie: SESSION } }))).text());
    const section = page.querySelector("[data-account-marketing]")!;
    expect(text(section.querySelector("h2"))).toBe("News and offers");
    const box = (channel: string) => section.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${channel}"]`)!;
    expect(box("sms").hasAttribute("checked")).toBe(true);
    expect(box("whatsapp").hasAttribute("checked")).toBe(false);
    expect(box("push").hasAttribute("checked")).toBe(false);
    expect(text(section)).toContain("separate from order updates");
    expect(box("email").hasAttribute("disabled")).toBe(true);
    expect(text(section)).toContain("Add an email to your account to get offers by email.");
    expect(Array.from(section.querySelectorAll('input[type="hidden"][name^="was_"]')).map((input) => `${input.getAttribute("name")}=${input.getAttribute("value")}`))
      .toEqual(["was_sms=on", "was_whatsapp=off", "was_push=off"]);
    expect(section.querySelector("form")!.getAttribute("method")).toBe("post");
  });

  it("speaks the store's language", async () => {
    stubApi("bn");
    const page = parse(await (await renderProfile(new Request("https://shop.test/account/profile?marketing=saved", { headers: { Cookie: SESSION } }))).text());
    const section = page.querySelector("[data-account-marketing]")!;
    expect(section.getAttribute("lang")).toBe("bn");
    expect(text(section.querySelector("h2"))).toBe("নতুন খবর ও অফার");
    expect(text(section.querySelector('[role="status"]'))).toBe("পছন্দ সেভ হয়েছে।");
  });

  it("sends only the changed channels and lands back with a flag", async () => {
    const puts = stubApi();
    const body = new URLSearchParams([
      ["intent", "marketing"], ["language", "en"],
      ["was_sms", "on"], ["was_whatsapp", "off"],
      ["channel", "sms"], ["channel", "whatsapp"],
    ]);
    const response = await renderProfile(new Request("https://shop.test/account/profile", {
      method: "POST",
      body,
      headers: { Cookie: SESSION, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://shop.test" },
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/account/profile?marketing=saved#marketing");
    expect(puts).toEqual([{ path: "/api/v1/customer-auth/marketing", body: { whatsapp: true, language: "en" } }]);
  });
});


it("opts only workspace account shells into the literal activation contract", async () => {
  const render = async (layout?: "workspace") => parse(await container.renderToString(AccountShell, {
    request: new Request("https://shop.test/account/inbox"),
    props: { current: "inbox", summary: null, state: "ok", title: "Conversation", layout },
    slots: { default: "<p>Conversation content</p>" },
  }));
  const workspace = await render("workspace");
  expect(workspace.querySelector('[data-account-shell]')!.getAttribute('data-account-workspace')).toBe("true");
  const list = await render();
  expect(list.querySelector('[data-account-shell]')!.hasAttribute('data-account-workspace')).toBe(false);
  expect(list.querySelector('[data-account-shell] > p')?.textContent).toBe("Conversation content");
});
