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
const blockerMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => routerMock,
  useBlocker: (options: unknown) => {
    blockerMock(options);
    return { proceed: vi.fn(), reset: vi.fn(), status: "idle" };
  },
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
    blockerMock.mockReset();
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

  function saveBar() {
    return host.querySelector<HTMLElement>('[data-testid="contextual-save-bar"]');
  }

  function buttonNamed(label: string) {
    const button = queryButtonNamed(label);

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

  it("shows the current profile in an annotated section with no save bar until it changes", () => {
    renderProfileHeader();

    const input = displayNameInput();
    expect(input.value).toBe(currentUser.name);
    expect(host.textContent).toContain(currentUser.email);
    expect(host.querySelector('[data-testid="settings-section"]')).not.toBeNull();
    expect(saveBar()).toBeNull();
    expect(queryButtonNamed("Save profile")).toBeNull();

    // The photo controls stay reachable on touch beside the media picker.
    const mediaActions = host.querySelector<HTMLElement>("[data-profile-edit-actions]");
    expect(mediaActions?.className).toContain("min-h-11");
    expect(
      buttonNamed("Change photo").closest("[data-profile-edit-actions]"),
    ).toBe(mediaActions);
  });

  it("reveals the contextual save bar once the draft differs from the saved profile", () => {
    renderProfileHeader();

    act(() => {
      setInputValue(displayNameInput(), "Temporary Name");
    });

    const bar = saveBar();
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("role")).toBe("status");
    expect(normalizeText(bar?.textContent ?? null)).toContain("Unsaved changes");
    expect(buttonNamed("Save profile").disabled).toBe(false);
    expect(buttonNamed("Discard").disabled).toBe(false);
  });

  it("blocks navigation through the router blocker without the native unload prompt", () => {
    renderProfileHeader();

    act(() => {
      setInputValue(displayNameInput(), "Temporary Name");
    });

    const options = blockerMock.mock.calls.at(-1)?.[0] as {
      enableBeforeUnload?: boolean;
      disabled?: boolean;
      withResolver?: boolean;
    };
    expect(options.enableBeforeUnload).toBe(false);
    expect(options.disabled).toBe(false);
    expect(options.withResolver).toBe(true);
  });

  it("restores the prior display name on discard without saving", () => {
    renderProfileHeader();

    act(() => {
      setInputValue(displayNameInput(), "Temporary Name");
    });

    expect(displayNameInput().value).toBe("Temporary Name");
    expect(buttonNamed("Save profile").disabled).toBe(false);

    act(() => {
      click(buttonNamed("Discard"));
    });

    expect(displayNameInput().value).toBe(currentUser.name);
    expect(host.textContent).toContain(currentUser.email);
    expect(saveBar()).toBeNull();
    expect(queryButtonNamed("Save profile")).toBeNull();
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it("keeps saving blocked and explains why while the name is too short", () => {
    renderProfileHeader();

    act(() => {
      setInputValue(displayNameInput(), "A");
    });

    expect(buttonNamed("Save profile").disabled).toBe(true);
    expect(displayNameInput().getAttribute("aria-invalid")).toBe("true");
    const fieldError = host.querySelector('[data-testid="field-error"]');
    expect(normalizeText(fieldError?.textContent ?? null)).toContain("at least 2 characters");

    act(() => {
      click(buttonNamed("Save profile"));
    });
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it("saves the trimmed display name while preserving the current profile image", async () => {
    updateProfileMock.mockResolvedValueOnce({
      user: { name: "Arobi Owner", image: currentUser.image },
    });
    renderProfileHeader();

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
    expect(displayNameInput().value).toBe("Arobi Owner");
    expect(saveBar()).toBeNull();
    expect(queryButtonNamed("Save profile")).toBeNull();
    expect(toastMock.success).toHaveBeenCalledWith("Profile saved");
    expect(refreshAdminRouteContextMock).toHaveBeenCalledWith(routerMock);
  });
});
