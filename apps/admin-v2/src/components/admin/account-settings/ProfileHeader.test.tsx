// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ProfileHeader } from "./ProfileHeader";
import { SaveBarProvider, SaveErrorBanner } from "../shared/SaveBar";
import type { User } from "./ProfileHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const routerMock = vi.hoisted(() => ({ id: "account-router" }));
const updateProfileMock = vi.hoisted(() => vi.fn());
const refreshAdminRouteContextMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => routerMock,
  useBlocker: () => ({ proceed: vi.fn(), reset: vi.fn(), status: "idle" }),
}));

vi.mock("~/lib/api", () => ({ apiData: (call: unknown) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminAuthUpdateProfile: updateProfileMock,
}));

vi.mock("~/lib/admin-route-context", () => ({
  refreshAdminRouteContext: refreshAdminRouteContextMock,
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

vi.mock("../media-manager", () => ({
  MediaManager: ({ trigger }: { trigger: React.ReactElement }) => (
    <div data-testid="profile-media-trigger">{trigger}</div>
  ),
}));

const currentUser: User = {
  id: "user_1",
  name: "Arobi Admin",
  email: "owner@example.com",
  image: "https://cdn.example.com/avatar.png",
  role: "admin",
  twoFactorEnabled: true,
};

describe("ProfileHeader profile card", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    updateProfileMock.mockReset();
    updateProfileMock.mockResolvedValue({
      user: { name: currentUser.name, image: currentUser.image },
    });
    refreshAdminRouteContextMock.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  function renderProfileHeader(user: User = currentUser) {
    act(() => {
      root.render(
        <SaveBarProvider>
          <SaveErrorBanner />
          <ProfileHeader user={user} />
        </SaveBarProvider>,
      );
    });
  }

  function buttonNamed(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find((node) =>
      normalizeText(node.textContent) === label,
    );

    if (!button) {
      throw new Error(`Expected button named "${label}"`);
    }

    return button;
  }

  function queryButtonNamed(label: string) {
    return (
      Array.from(document.querySelectorAll("button")).find((node) =>
        normalizeText(node.textContent) === label,
      ) ?? null
    );
  }

  function nameInput() {
    const input = host.querySelector<HTMLInputElement>("#profile-name");

    if (!input) {
      throw new Error("Expected the name input");
    }

    return input;
  }

  function click(element: Element) {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function normalizeText(value: string | null) {
    return value?.replace(/\s+/g, " ").trim() ?? "";
  }

  async function flushReactUpdates() {
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("shows the saved profile and no save bar until something changes", () => {
    renderProfileHeader();

    expect(nameInput().value).toBe(currentUser.name);
    expect(host.textContent).toContain(currentUser.email);
    expect(queryButtonNamed("Save")).toBeNull();
    expect(queryButtonNamed("Discard")).toBeNull();
  });

  it("discards an edited name without saving", async () => {
    renderProfileHeader();

    act(() => setInputValue(nameInput(), "Temporary Name"));
    expect(buttonNamed("Save").disabled).toBe(false);

    act(() => click(buttonNamed("Discard")));
    await flushReactUpdates();
    act(() => click(buttonNamed("Discard changes")));
    await flushReactUpdates();

    expect(nameInput().value).toBe(currentUser.name);
    expect(queryButtonNamed("Save")).toBeNull();
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it("refuses a one-character name without calling the API", async () => {
    renderProfileHeader();

    act(() => setInputValue(nameInput(), " A "));
    act(() => click(buttonNamed("Save")));
    await flushReactUpdates();

    expect(updateProfileMock).not.toHaveBeenCalled();
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Enter at least 2 characters.");
  });

  it("saves the trimmed name while preserving the current profile image", async () => {
    updateProfileMock.mockResolvedValueOnce({
      user: { name: "Arobi Owner", image: currentUser.image },
    });
    renderProfileHeader();

    act(() => setInputValue(nameInput(), "  Arobi Owner  "));
    act(() => click(buttonNamed("Save")));
    await flushReactUpdates();

    expect(updateProfileMock).toHaveBeenCalledWith({
      body: { name: "Arobi Owner", image: currentUser.image },
    });
    expect(nameInput().value).toBe("Arobi Owner");
    expect(queryButtonNamed("Save")).toBeNull();
    expect(toastMock.success).toHaveBeenCalledWith("Changes saved");
    expect(refreshAdminRouteContextMock).toHaveBeenCalledWith(routerMock);
  });

  it("keeps the edit and shows the error when the save fails", async () => {
    updateProfileMock.mockRejectedValueOnce(new Error("Profile service unavailable"));
    renderProfileHeader();

    act(() => setInputValue(nameInput(), "Arobi Owner"));
    act(() => click(buttonNamed("Save")));
    await flushReactUpdates();

    expect(nameInput().value).toBe("Arobi Owner");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Profile: Profile service unavailable");
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
