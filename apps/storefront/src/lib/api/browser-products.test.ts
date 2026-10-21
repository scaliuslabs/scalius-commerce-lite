// @vitest-environment happy-dom

// The browser reads replace the generated SDK + transport on buyer pages. This
// runs both against the same answers and requires the same requests (URL,
// method, headers, attempts) and the same results.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchProductBySlugResult, fetchProductsByIds } from "./browser-products";
import { getAllProducts, getProductBySlugResult } from "./products";

type Answer = () => Response | Promise<Response>;

interface SentRequest {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: unknown;
}

function stubFetch(answers: Answer[]): SentRequest[] {
  const sent: SentRequest[] = [];
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    sent.push({
      url: request ? request.url : String(input),
      method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
      headers: [...new Headers(init?.headers ?? request?.headers).entries()],
      body: init?.body ?? null,
    });
    const answer = answers[Math.min(call, answers.length - 1)]!;
    call += 1;
    return answer();
  }));
  return sent;
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const networkError = () => () => Promise.reject(new TypeError("Failed to fetch"));

const product = {
  id: "prod_1",
  slug: "linen-panjabi",
  name: "Linen panjabi",
};
const productPage = {
  success: true,
  data: {
    product,
    category: null,
    media: [],
    variants: [{ id: "sku_1" }],
    recommendations: { reason: "popular", products: [] },
  },
};
const productList = {
  success: true,
  data: {
    products: [product, { ...product, id: "prod_2" }],
    pagination: { page: 1, limit: 12, total: 2, totalPages: 1 },
    facets: [{ id: "f", name: "Size", slug: "option.size", values: [{ value: "m", count: 1 }] }],
    priceRange: { min: 1, max: 9 },
  },
};

const LIST_CASES: Array<[string, Answer[]]> = [
  ["a product list", [json(productList)]],
  ["an empty JSON body", [() => new Response("", { status: 200, headers: { "Content-Type": "application/json" } })]],
  ["a non-JSON answer", [() => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } })]],
  ["malformed JSON", [() => new Response("{", { status: 200, headers: { "Content-Type": "application/json" } })]],
  ["a refusal", [json({ success: false, error: "boom" }, 500)]],
  ["a text refusal", [() => new Response("Bad gateway", { status: 502 })]],
  ["a network failure, then an answer", [networkError(), json(productList)]],
  ["a network failure on every attempt", [networkError()]],
];

const SLUG_CASES: Array<[string, Answer[]]> = [
  ["a product", [json(productPage)]],
  ["a 404", [json({ success: false, error: "Not found" }, 404)]],
  ["a refusal", [json({ success: false }, 503)]],
  ["a payload without variants", [json({ success: true, data: { ...productPage.data, variants: null } })]],
  ["a non-JSON answer", [() => new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } })]],
  ["a network failure on every attempt", [networkError()]],
];

describe("browser product reads", () => {
  beforeEach(() => {
    window.__API_BASE_URL__ = "https://api.example.test/api/v1";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete window.__API_BASE_URL__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(LIST_CASES)("lists products by id as the SDK did: %s", async (_name, answers) => {
    const viaSdk = stubFetch(answers);
    const expected = await getAllProducts({ ids: "prod_1,prod 2/é", limit: 12 });
    vi.unstubAllGlobals();
    const viaFetch = stubFetch(answers);
    const actual = await fetchProductsByIds("prod_1,prod 2/é", 12);

    expect(actual).toEqual(expected);
    expect(viaFetch).toEqual(viaSdk);
    expect(viaFetch[0]).toMatchObject({
      url: "https://api.example.test/api/v1/products?ids=prod_1%2Cprod%202%2F%C3%A9&limit=12",
      method: "GET",
      headers: [],
    });
  });

  it.each(SLUG_CASES)("reads a product by handle as the SDK did: %s", async (_name, answers) => {
    const viaSdk = stubFetch(answers);
    const expected = await getProductBySlugResult("linen panjabi/ü");
    vi.unstubAllGlobals();
    const viaFetch = stubFetch(answers);
    const actual = await fetchProductBySlugResult("linen panjabi/ü");

    expect(actual).toEqual(expected);
    expect(viaFetch).toEqual(viaSdk);
    expect(viaFetch[0]?.url).toBe("https://api.example.test/api/v1/products/linen%20panjabi%2F%C3%BC");
  });

  it("fails closed without the public API URL, as the SDK read did", async () => {
    delete window.__API_BASE_URL__;
    const sent = stubFetch([json(productList)]);
    expect(await fetchProductsByIds("prod_1", 12)).toBeNull();
    expect(await fetchProductBySlugResult("linen-panjabi")).toEqual({ state: "unavailable" });
    expect(sent).toEqual([]);
  });
});
