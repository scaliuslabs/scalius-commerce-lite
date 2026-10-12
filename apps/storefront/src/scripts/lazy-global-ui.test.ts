// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installLazyGlobalUi } from "./lazy-global-ui";

vi.mock("@/scripts/rail-focus", () => ({ installRailFocus: vi.fn() }));

afterEach(() => {
  window.__scaliusLazyGlobalUiInstalled = false;
  document.cookie = "cs_auth=; Max-Age=0; path=/";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("lazy customer session hint", () => {
  it.each([["1", 1], ["10", 0], ["0", 0], ["", 0]] as const)(
    "resumes auth only for exact cs_auth=1 (value %s)", (value, expected) => {
      document.cookie = `cs_auth=${value}; path=/`;
      const idle = vi.fn();
      vi.stubGlobal("requestIdleCallback", idle);
      // Do not mount global UI or retain listeners during this installer test.
      vi.spyOn(window, "addEventListener").mockImplementation(() => {});
      vi.spyOn(document, "addEventListener").mockImplementation(() => {});
      installLazyGlobalUi();
      expect(idle).toHaveBeenCalledTimes(expected);
    },
  );
});
