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
import type { User } from "./AccountSettingsContainer";

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

vi.mock("~/lib/api-functions/auth-management", () => ({
  updateProfile: updateProfileMock,
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

describe("ProfileHeader display-name editing", () => {
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
      root.render(<ProfileHeader user={user} />);
    });
  }

  function buttonNamed(label: string) {
    const button = Array.from(host.querySelectorAll("button")).find((node) =>
      normalizeText(node.textContent).includes(label),
    );

    if (!button) {
      throw new Error(`Expected button named "${label}"`);
    }

    return button;
  }

  function queryButtonNamed(label: string) {
    return (
      Array.from(host.querySelectorAll("button")).find((node) =>
        normalizeText(node.textContent).includes(label),
      ) ?? null
    );
  }

  function displayNameInput() {
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Display name"]',
    );

    if (!input) {
      throw new Error("Expected display name input");
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

  it("opens editing with current user data and reachable save/cancel controls", () => {
    renderProfileHeader();

    expect(host.querySelector("h2")?.textContent).toBe(currentUser.name);
    expect(host.textContent).toContain(currentUser.email);

    act(() => {
      click(buttonNamed("Edit profile"));
    });

    const input = displayNameInput();
    const cancelButton = buttonNamed("Cancel");
    const saveButton = buttonNamed("Save profile");

    expect(input.value).toBe(currentUser.name);
    expect(host.textContent).toContain(currentUser.email);
    expect(cancelButton.disabled).toBe(false);
    expect(saveButton.disabled).toBe(true);
    expect(saveButton.parentElement).toBe(cancelButton.parentElement);
    expect(saveButton.closest("[data-profile-edit-actions]")).toBe(
      cancelButton.closest("[data-profile-edit-actions]"),
    );
    expect(
      saveButton.closest("[data-profile-edit-actions]")?.className,
    ).toContain("min-h-11");
  });

  it("restores the prior display name on cancel without saving", () => {
    renderProfileHeader();

    act(() => {
      click(buttonNamed("Edit profile"));
    });

    act(() => {
      setInputValue(displayNameInput(), "Temporary Name");
    });

    expect(displayNameInput().value).toBe("Temporary Name");
    expect(buttonNamed("Save profile").disabled).toBe(false);

    act(() => {
      click(buttonNamed("Cancel"));
    });

    expect(host.querySelector("h2")?.textContent).toBe(currentUser.name);
    expect(host.textContent).toContain(currentUser.email);
    expect(queryButtonNamed("Save profile")).toBeNull();
    expect(host.querySelector('input[aria-label="Display name"]')).toBeNull();
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it("saves the trimmed display name while preserving the current profile image", async () => {
    updateProfileMock.mockResolvedValueOnce({
      user: { name: "Arobi Owner", image: currentUser.image },
    });
    renderProfileHeader();

    act(() => {
      click(buttonNamed("Edit profile"));
    });

    act(() => {
      setInputValue(displayNameInput(), "  Arobi Owner  ");
    });

    act(() => {
      click(buttonNamed("Save profile"));
    });
    await flushReactUpdates();

    expect(updateProfileMock).toHaveBeenCalledWith({
      data: {
        name: "Arobi Owner",
        image: currentUser.image,
      },
    });
    expect(host.querySelector("h2")?.textContent).toBe("Arobi Owner");
    expect(queryButtonNamed("Save profile")).toBeNull();
    expect(buttonNamed("Edit profile")).toBeTruthy();
    expect(toastMock.success).toHaveBeenCalledWith("Profile saved");
    expect(refreshAdminRouteContextMock).toHaveBeenCalledWith(routerMock);
  });
});
