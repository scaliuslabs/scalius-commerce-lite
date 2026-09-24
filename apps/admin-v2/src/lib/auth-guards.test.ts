// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminApiResponseError } from "./admin-api-error";
import { beginBootSessionRead, endBootSessionRead, readDashboardSession } from "./auth-guards";

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

  it("answers every guard of the first load from the read index.html started, then reads afresh", async () => {
    const signedOut = { adminExists: true, signIn: { localLoginDisabled: false, identityHandoffEnabled: false }, session: null };
    const fetchMock = vi.fn(async () => Response.json(signedOut));
    vi.stubGlobal("fetch", fetchMock);
    const early = Promise.resolve(Response.json(signedOut));
    (window as Window & { __scaliusSession?: Promise<Response> }).__scaliusSession = early;

    beginBootSessionRead();
    // The admin guard and the sign-in page it redirects to share one read.
    await expect(readDashboardSession()).resolves.toMatchObject({ session: null });
    await expect(readDashboardSession()).resolves.toMatchObject({ session: null });
    expect(fetchMock).not.toHaveBeenCalled();
    endBootSessionRead();

    await readDashboardSession();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
