// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cleared = vi.hoisted(() => vi.fn());
vi.mock("./admin-route-context", () => ({ clearAdminRouteContextCache: cleared }));

import { ADMIN_SESSION_LOST_EVENT, noticeAdminUnauthorized } from "./admin-session-lost";

function sessionResponse(session: unknown) {
  return new Response(JSON.stringify({ adminExists: true, signIn: {}, session }), { status: 200 });
}

describe("a 401 from an admin request", () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("location", { ...window.location, replace, pathname: "/admin/customers" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("leaves the shell for the sign-in page once the server says the session is gone", async () => {
    const fetchMock = vi.fn(async () => sessionResponse(null));
    vi.stubGlobal("fetch", fetchMock);
    // Every failing list reports at once: one session check, one redirect.
    await Promise.all([noticeAdminUnauthorized(), noticeAdminUnauthorized(), noticeAdminUnauthorized()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/api/auth/dashboard-session");
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/auth/login");
  });

  it("stays put when the session is fine (the call refused on its own terms, e.g. a wrong code)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sessionResponse({ user: { id: "u1" }, twoFactorVerified: true, permissions: [] })));
    await noticeAdminUnauthorized();
    expect(replace).not.toHaveBeenCalled();
  });

  it("keeps a page with unsaved edits and tells its save bar instead of leaving", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sessionResponse(null)));
    const bar = document.createElement("div");
    bar.setAttribute("data-save-bar", "");
    document.body.append(bar);
    const heard = vi.fn();
    window.addEventListener(ADMIN_SESSION_LOST_EVENT, heard);
    await noticeAdminUnauthorized();
    window.removeEventListener(ADMIN_SESSION_LOST_EVENT, heard);
    bar.remove();
    expect(replace).not.toHaveBeenCalled();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stays put when the session can't be read (offline)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await noticeAdminUnauthorized();
    expect(replace).not.toHaveBeenCalled();
  });
});
