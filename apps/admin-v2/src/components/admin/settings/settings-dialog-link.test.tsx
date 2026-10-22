// @vitest-environment happy-dom

// A hint that says to set something up links to the dialog with its fields
// (buyer QA N3: "Set up Email in Notifications first" landed on a long page
// where the merchant could not find the email setup).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const location = vi.hoisted(() => ({ hash: "" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => <a href={to} {...props}>{children}</a>,
  useLocation: ({ select }: { select: (value: { hash: string }) => string }) => select(location),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ navigate: vi.fn(), history: { push: vi.fn() } }),
  useRouterState: () => ({ location: { pathname: "/admin/settings/notifications" } }),
  useBlocker: () => ({ proceed: undefined, reset: undefined, status: "idle" }),
}));

import { SettingsDialog, SettingsPage } from "./SettingsPage";
import { SENDING_DIALOG } from "./sending-dialogs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(hash: string) {
  location.hash = hash;
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsPage page="notifications">
          <SettingsDialog id={SENDING_DIALOG.email} title="Email" trigger={<button type="button">Email</button>}>
            <p>Email fields</p>
          </SettingsDialog>
          <SettingsDialog id={SENDING_DIALOG.sms} title="SMS" trigger={<button type="button">SMS</button>}>
            <p>SMS fields</p>
          </SettingsDialog>
        </SettingsPage>
      </QueryClientProvider>,
    );
  });
}

const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");

describe("a settings dialog with a link id", () => {
  it("opens when the page is opened at its hash, and only that one", () => {
    render(`${SENDING_DIALOG.email}`);
    expect(dialog()?.textContent).toContain("Email fields");
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(1);
  });

  it("stays closed on the page without the hash", () => {
    render("sending");
    expect(dialog()).toBeNull();
  });
});
