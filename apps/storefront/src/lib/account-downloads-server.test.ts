// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api/transport", () => ({
  resolveBackendTarget: (path: string) => ({
    url: `https://api.internal${path}`,
    fetch: api.fetch,
    viaServiceBinding: true,
  }),
}));

import { readAccountDownloads, revealLicenceKey } from "./account-downloads-server";
import { getOrderReceiptCookieName } from "./order-receipt-cookie";
import { GET as getAccountStream } from "../pages/api/downloads/account/[entitlementId]/[exp]/[sig]";
import { GET as getOrderStream } from "../pages/api/downloads/order/[orderId]/[entitlementId]/[exp]/[sig]";
import { POST as postTicket } from "../pages/api/downloads/ticket";

const ORIGIN = "https://shop.example.test";
const ORDER = "ord_1";
const ENT = "dge_file0000000001";
const SIG = "S".repeat(43);
const EXP = "1790000600";
const PROOF = `chk_${"p".repeat(40)}`;
const SESSION = "cs_tok=session-token-value";
const RECEIPT_COOKIE = `${getOrderReceiptCookieName(ORDER)}=${PROOF}`;

type RouteContext = Parameters<typeof getAccountStream>[0];

function request(path: string, init: { method?: string; cookie?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { Origin: ORIGIN, ...init.headers };
  if (init.cookie) headers.Cookie = init.cookie;
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

function route(req: Request, params: Record<string, string>): RouteContext {
  return { request: req, params } as unknown as RouteContext;
}

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

function calls() {
  return api.fetch.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit, headers: new Headers((init as RequestInit).headers) }));
}

function fileResponse(status: number, extra: Record<string, string> = {}): Response {
  return new Response(status === 416 ? null : "file-bytes", {
    status,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename*=UTF-8''Guide.pdf",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
      "Referrer-Policy": "no-referrer",
      "Content-Length": "10",
      "Set-Cookie": "leak=1",
      ...extra,
    },
  });
}

beforeEach(() => {
  api.fetch.mockReset();
});

describe("download stream proxy", () => {
  it("streams an account ticket with the session cookie only and forwards Range", async () => {
    api.fetch.mockResolvedValueOnce(fileResponse(206, { "Content-Range": "bytes 0-9/100" }));
    const response = await getAccountStream(route(
      request(`/api/downloads/account/${ENT}/${EXP}/${SIG}`, { cookie: `${SESSION}; ${RECEIPT_COOKIE}; other=1`, headers: { Range: "bytes=0-9" } }),
      { entitlementId: ENT, exp: EXP, sig: SIG },
    ));
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("file-bytes");
    expect(response.headers.get("Content-Range")).toBe("bytes 0-9/100");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const [call] = calls();
    expect(call!.url).toBe(`https://api.internal/api/v1/orders/downloads/${ENT}/${EXP}/${SIG}`);
    expect(call!.headers.get("Cookie")).toBe(SESSION);
    expect(call!.headers.get("X-Receipt-Token")).toBeNull();
    expect(call!.headers.get("Range")).toBe("bytes=0-9");
  });

  it("streams a receipt ticket with the receipt proof header only", async () => {
    api.fetch.mockResolvedValueOnce(fileResponse(200));
    const response = await getOrderStream(route(
      request(`/api/downloads/order/${ORDER}/${ENT}/${EXP}/${SIG}`, { cookie: `${SESSION}; ${RECEIPT_COOKIE}` }),
      { orderId: ORDER, entitlementId: ENT, exp: EXP, sig: SIG },
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    const [call] = calls();
    expect(call!.headers.get("X-Receipt-Token")).toBe(PROOF);
    expect(call!.headers.get("Cookie")).toBeNull();
    expect(call!.url).not.toContain(PROOF);
  });

  it("passes 416 through without a body", async () => {
    api.fetch.mockResolvedValueOnce(fileResponse(416, { "Content-Range": "bytes */100" }));
    const response = await getAccountStream(route(
      request(`/api/downloads/account/${ENT}/${EXP}/${SIG}`, { cookie: SESSION, headers: { Range: "bytes=500-" } }),
      { entitlementId: ENT, exp: EXP, sig: SIG },
    ));
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */100");
  });

  it("answers 404 before calling the API for malformed params or no proof", async () => {
    const bad = [
      { entitlementId: "dge 1", exp: EXP, sig: SIG },
      { entitlementId: ENT, exp: "12x", sig: SIG },
      { entitlementId: ENT, exp: EXP, sig: "bad+sig=" },
    ];
    for (const params of bad) {
      const response = await getAccountStream(route(request("/api/downloads/account/x/y/z", { cookie: SESSION }), params));
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    const noSession = await getAccountStream(route(request("/api/downloads/account/x/y/z"), { entitlementId: ENT, exp: EXP, sig: SIG }));
    expect(noSession.status).toBe(404);
    const badOrder = await getOrderStream(route(request("/x", { cookie: RECEIPT_COOKIE }), { orderId: "../x", entitlementId: ENT, exp: EXP, sig: SIG }));
    expect(badOrder.status).toBe(404);
    const noReceipt = await getOrderStream(route(request("/x", { cookie: SESSION }), { orderId: ORDER, entitlementId: ENT, exp: EXP, sig: SIG }));
    expect(noReceipt.status).toBe(404);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("drops a malformed Range and maps API refusals to 404 / 503", async () => {
    api.fetch.mockResolvedValueOnce(Response.json({ success: false }, { status: 404 }));
    const refused = await getAccountStream(route(
      request(`/api/downloads/account/${ENT}/${EXP}/${SIG}`, { cookie: SESSION, headers: { Range: "bytes=0-1, 5-9" } }),
      { entitlementId: ENT, exp: EXP, sig: SIG },
    ));
    expect(refused.status).toBe(404);
    expect(calls()[0]!.headers.get("Range")).toBeNull();

    api.fetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
    const down = await getAccountStream(route(request(`/api/downloads/account/${ENT}/${EXP}/${SIG}`, { cookie: SESSION }), { entitlementId: ENT, exp: EXP, sig: SIG }));
    expect(down.status).toBe(503);

    api.fetch.mockRejectedValueOnce(new Error("network"));
    const failed = await getAccountStream(route(request(`/api/downloads/account/${ENT}/${EXP}/${SIG}`, { cookie: SESSION }), { entitlementId: ENT, exp: EXP, sig: SIG }));
    expect(failed.status).toBe(503);
  });

  it("refuses to serve a success that is not an attachment", async () => {
    api.fetch.mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    const response = await getAccountStream(route(request(`/api/downloads/account/${ENT}/${EXP}/${SIG}`, { cookie: SESSION }), { entitlementId: ENT, exp: EXP, sig: SIG }));
    expect(response.status).toBe(404);
  });
});

describe("Download form post", () => {
  function post(fields: Record<string, string>, cookie?: string, origin = ORIGIN) {
    return postTicket(route(request("/api/downloads/ticket", {
      method: "POST",
      cookie,
      body: form(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
    }), {}));
  }

  it("mints with the session and 303s to the stream path", async () => {
    const href = `/api/downloads/account/${ENT}/${EXP}/${SIG}`;
    api.fetch.mockResolvedValueOnce(Response.json({ success: true, data: { href, expiresAt: "2026-09-25T00:10:00Z", downloadCount: 2, downloadLimit: 5 } }));
    const response = await post({ entitlementId: ENT, returnTo: "/account/downloads" }, SESSION);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(href);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const [call] = calls();
    expect(call!.url).toBe(`https://api.internal/api/v1/customer-auth/downloads/${ENT}/ticket`);
    expect(call!.init.method).toBe("POST");
    expect(call!.headers.get("Cookie")).toBe(SESSION);
  });

  it("mints a receipt ticket with the proof header when the form names the order", async () => {
    const href = `/api/downloads/order/${ORDER}/${ENT}/${EXP}/${SIG}`;
    api.fetch.mockResolvedValueOnce(Response.json({ success: true, data: { href, expiresAt: "x", downloadCount: 1, downloadLimit: null } }));
    const response = await post({ entitlementId: ENT, orderId: ORDER, returnTo: `/order-success?orderId=${ORDER}` }, `${SESSION}; ${RECEIPT_COOKIE}`);
    expect(response.headers.get("Location")).toBe(href);
    const [call] = calls();
    expect(call!.url).toBe(`https://api.internal/api/v1/orders/receipt/${ORDER}/downloads/${ENT}/ticket`);
    expect(call!.headers.get("X-Receipt-Token")).toBe(PROOF);
    expect(call!.headers.get("Cookie")).toBeNull();
  });

  it("303s back with only the outcome flag and the file anchor", async () => {
    api.fetch.mockResolvedValueOnce(Response.json({ success: false, error: { code: "DOWNLOAD_LIMIT_REACHED", message: "x" } }, { status: 409 }));
    const limit = await post({ entitlementId: ENT, returnTo: "/account/orders/ord_1" }, SESSION);
    expect(limit.headers.get("Location")).toBe(`/account/orders/ord_1?download=limit#download-${ENT}`);

    api.fetch.mockResolvedValueOnce(Response.json({ success: false, error: { code: "DOWNLOAD_EXPIRED", message: "x" } }, { status: 409 }));
    const expired = await post({ entitlementId: ENT, returnTo: "/account/downloads" }, SESSION);
    expect(expired.headers.get("Location")).toBe(`/account/downloads?download=expired#download-${ENT}`);
  });

  it("never redirects to an unexpected href from the API", async () => {
    api.fetch.mockResolvedValueOnce(Response.json({ success: true, data: { href: "https://evil.test/steal" } }));
    const response = await post({ entitlementId: ENT, returnTo: "/account/downloads" }, SESSION);
    expect(response.headers.get("Location")).toBe(`/account/downloads?download=unavailable#download-${ENT}`);
  });

  it("refuses without calling the API when proof, ids or return path are wrong", async () => {
    const signedOut = await post({ entitlementId: ENT, returnTo: "/account/downloads" });
    expect(signedOut.headers.get("Location")).toBe(`/account/downloads?download=signin#download-${ENT}`);
    const noReceipt = await post({ entitlementId: ENT, orderId: ORDER, returnTo: "https://evil.test/" }, SESSION);
    expect(noReceipt.headers.get("Location")).toBe(`/order-success?orderId=${ORDER}&download=missing#download-${ENT}`);
    const badId = await post({ entitlementId: "../x", returnTo: "/account/downloads" }, SESSION);
    expect(badId.headers.get("Location")).toBe("/account/downloads?download=missing");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("refuses a cross-site post carrying cookies", async () => {
    const response = await post({ entitlementId: ENT }, SESSION, "https://evil.test");
    expect(response.status).toBe(403);
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe("reads and reveals", () => {
  it("reads the account list with the session only", async () => {
    api.fetch.mockResolvedValueOnce(Response.json({ success: true, data: { lines: [] } }));
    const result = await readAccountDownloads(request("/account/downloads", { cookie: SESSION }));
    expect(result).toEqual({ ok: true, data: [] });
    expect(calls()[0]!.url).toBe("https://api.internal/api/v1/customer-auth/downloads");
    expect(await readAccountDownloads(request("/account/downloads"))).toEqual({ ok: false, reason: "signed_out" });
    api.fetch.mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect(await readAccountDownloads(request("/account/downloads", { cookie: SESSION }))).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reveals a key with the right proof and never puts it in the URL", async () => {
    api.fetch.mockResolvedValueOnce(Response.json({ success: true, data: { keyId: "dlk_1", key: "AAAA-BBBB-CCCC", last4: "CCCC" } }));
    const result = await revealLicenceKey(request("/account/licence-key", { cookie: RECEIPT_COOKIE }), { kind: "receipt", orderId: ORDER }, "dlk_1");
    expect(result).toEqual({ ok: true, key: "AAAA-BBBB-CCCC", last4: "CCCC" });
    const [call] = calls();
    expect(call!.url).toBe(`https://api.internal/api/v1/orders/receipt/${ORDER}/licence-keys/dlk_1/reveal`);
    expect(call!.url).not.toContain("AAAA");
    expect(call!.headers.get("X-Receipt-Token")).toBe(PROOF);

    api.fetch.mockResolvedValueOnce(Response.json({ success: false, error: { code: "RATE_LIMITED" } }, { status: 429 }));
    expect(await revealLicenceKey(request("/x", { cookie: SESSION }), { kind: "account" }, "dlk_1")).toEqual({ ok: false, flag: "rate" });
  });
});
