import { postApiV1AdminAppsUpload } from "@scalius/api-client/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "./admin-api-error";
import { apiData, fetchAdminApi } from "./api";

describe("fetchAdminApi transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Every byte value, including sequences that are invalid UTF-8 (0x80-0xFF alone).
  const binary = Uint8Array.from({ length: 512 }, (_, index) => (index * 7) % 256);

  function captureFetch() {
    const sent: { body?: Uint8Array; init?: RequestInit } = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.init = init;
      sent.body = init.body === undefined ? undefined : new Uint8Array(init.body as ArrayBuffer);
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    return sent;
  }

  it("sends a binary body byte-identical", async () => {
    const sent = captureFetch();
    await fetchAdminApi(new Request("https://admin-api.invalid/api/v1/admin/apps/upload", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: binary,
    }));
    expect(sent.body).toEqual(binary);
    expect(new Headers(sent.init?.headers).get("content-type")).toBe("application/zip");
  });

  it("keeps an app ZIP byte-identical through the generated SDK", async () => {
    const sent = captureFetch();
    const file = new File([binary], "acme.engrave.zip", { type: "application/zip" });
    await postApiV1AdminAppsUpload({ body: file, query: {} });
    expect(sent.body?.byteLength).toBe(binary.byteLength);
    expect(sent.body).toEqual(binary);
  });

  it("sends no body for GET and for an empty body", async () => {
    const sent = captureFetch();
    await fetchAdminApi(new Request("https://admin-api.invalid/api/v1/admin/apps"));
    expect(sent.init?.body).toBeUndefined();
    await fetchAdminApi(new Request("https://admin-api.invalid/api/v1/admin/apps/x/pause", { method: "POST" }));
    expect(sent.init?.body).toBeUndefined();
  });
});

const reply = (status: number, body: { data?: unknown; error?: unknown }) =>
  Promise.resolve({ ...body, response: new Response(null, { status: status === 204 ? 204 : 200 }) });

describe("apiData envelope handling", () => {
  it("returns the envelope data, including a null payload", async () => {
    await expect(apiData(reply(200, { data: { success: true, data: { id: "c1" } } }))).resolves.toEqual({ id: "c1" });
    await expect(apiData(reply(200, { data: { success: true, data: null } }))).resolves.toBeNull();
  });

  it("strips success from envelopes that carry top-level fields", async () => {
    await expect(apiData(reply(200, { data: { success: true, sessions: [] } }))).resolves.toEqual({ sessions: [] });
  });

  it("returns undefined for 204 responses", async () => {
    await expect(apiData(reply(204, { data: {} }))).resolves.toBeUndefined();
  });

  it("keeps status, code and details from API error bodies", async () => {
    const error = await apiData(Promise.resolve({
      error: { success: false, error: { code: "revision_conflict", message: "Stale", details: { currentRevision: 3 } } },
      response: new Response(null, { status: 409 }),
    })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdminApiResponseError);
    expect(error).toMatchObject({ message: "Stale", status: 409, code: "revision_conflict", details: { currentRevision: 3 } });
  });

  it("falls back to the status when the error body is not an envelope", async () => {
    const error = await apiData(Promise.resolve({ error: "<html>bad gateway</html>", response: new Response(null, { status: 502 }) }))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "API error: 502", status: 502 });
  });

  it("rejects success:false even on a 2xx response", async () => {
    await expect(apiData(reply(200, { data: { success: false, error: "Denied" } }))).rejects.toThrow("Denied");
  });

  it("rethrows transport errors unchanged", async () => {
    const timeout = new Error("timed out");
    await expect(apiData(Promise.resolve({ error: timeout }))).rejects.toBe(timeout);
  });
});
