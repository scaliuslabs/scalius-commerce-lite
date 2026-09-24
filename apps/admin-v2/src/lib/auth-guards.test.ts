import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "./admin-api-error";
import { readDashboardSession } from "./auth-guards";

describe("dashboard session read", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the server's status when the session endpoint answers with an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad gateway", { status: 502 })));
    const error = await readDashboardSession().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AdminApiResponseError);
    expect(error).toMatchObject({ status: 502 });
  });

  it("lets a network failure through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(readDashboardSession()).rejects.toThrow(TypeError);
  });
});
