import { describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "./admin-api-error";

vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: vi.fn(),
  getResponseHeaders: vi.fn(() => new Headers()),
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));

const { apiData } = await import("./api");

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
      error: { success: false, error: { code: "REVISION_CONFLICT", message: "Stale", details: { currentRevision: 3 } } },
      response: new Response(null, { status: 409 }),
    })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdminApiResponseError);
    expect(error).toMatchObject({ message: "Stale", status: 409, code: "REVISION_CONFLICT", details: { currentRevision: 3 } });
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
