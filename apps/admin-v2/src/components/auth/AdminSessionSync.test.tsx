// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastListener } from "better-auth/client";
import { AdminSessionSync, broadcastAdminSignOut } from "./AdminSessionSync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listener: null as BroadcastListener | null,
  unsubscribe: vi.fn(),
  cleanup: vi.fn(),
  setup: vi.fn(),
  subscribe: vi.fn(),
  post: vi.fn(),
  clearRouteContext: vi.fn(),
}));

vi.mock("better-auth/client", () => ({
  getGlobalBroadcastChannel: () => ({
    subscribe: mocks.subscribe,
    setup: mocks.setup,
    post: mocks.post,
  }),
}));

vi.mock("../../lib/admin-route-context", () => ({
  clearAdminRouteContextCache: mocks.clearRouteContext,
}));

describe("AdminSessionSync", () => {
  let host: HTMLDivElement;
  let root: Root | null;
  let replace: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.listener = null;
    mocks.unsubscribe.mockReset();
    mocks.cleanup.mockReset();
    mocks.clearRouteContext.mockReset();
    mocks.post.mockReset();
    mocks.subscribe.mockReset().mockImplementation((listener: BroadcastListener) => {
      mocks.listener = listener;
      return mocks.unsubscribe;
    });
    mocks.setup.mockReset().mockReturnValue(mocks.cleanup);
    replace = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    host.remove();
    replace.mockRestore();
  });

  it("clears cached admin state and replace-navigates on cross-tab sign-out", () => {
    act(() => root?.render(<AdminSessionSync />));

    act(() => mocks.listener?.({
      event: "session",
      data: { trigger: "signout" },
      clientId: "other-tab",
      timestamp: 1,
    }));

    expect(mocks.clearRouteContext).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("/auth/login");
  });

  it("broadcasts a confirmed sign-out through Better Auth's session channel", () => {
    broadcastAdminSignOut();

    expect(mocks.post).toHaveBeenCalledWith({
      event: "session",
      data: { trigger: "signout" },
      clientId: expect.any(String),
    });
  });

  it("ignores non-sign-out updates and releases the shared listener", () => {
    act(() => root?.render(<AdminSessionSync />));
    act(() => mocks.listener?.({
      event: "session",
      data: { trigger: "updateUser" },
      clientId: "other-tab",
      timestamp: 1,
    }));

    expect(mocks.clearRouteContext).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();

    act(() => root?.unmount());
    root = null;
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});
