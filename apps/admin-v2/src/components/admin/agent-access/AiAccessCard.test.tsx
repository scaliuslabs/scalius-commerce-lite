// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionProvider } from "~/contexts/PermissionContext";

import { AiAccessCard } from "./AiAccessCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SECRET = "sat_live_0123456789abcdefghijklmnopqrstuv";

const api = vi.hoisted(() => ({
  listAgentConnections: vi.fn(),
  countClearableAgentConnections: vi.fn(),
  createAgentToken: vi.fn(),
  purgeRevokedAgentConnections: vi.fn(),
  revokeAgentGrant: vi.fn(),
  revokeAllAgentGrants: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("./api", () => api);
vi.mock("sonner", () => ({ toast: toasts }));

const connection = {
  id: "agr_1",
  kind: "oauth",
  resource: "dashboard",
  label: "Codex",
  clientName: "Codex",
  ownerName: "Owner",
  preset: "read",
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
  lastUsedAt: null,
};

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function render(permissions: string[], isSuperAdmin: boolean) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionProvider permissions={permissions} isSuperAdmin={isSuperAdmin}>
          <AiAccessCard />
        </PermissionProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}"`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function stored(storage: Storage): string {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)!;
    return `${key}=${storage.getItem(key)}`;
  }).join("\n");
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.listAgentConnections.mockResolvedValue({
    connections: [connection],
    pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
  });
  api.countClearableAgentConnections.mockResolvedValue({ revoked: 0, expired: 0, total: 0 });
  api.createAgentToken.mockResolvedValue({ token: SECRET, connection });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("AI & app access card", () => {
  it("shows a new access key once and keeps it out of storage, the URL, caches and toasts", async () => {
    await render(["agent_access.view", "agent_access.manage"], true);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex"));

    await click(button("Create access key"));
    await type(document.getElementById("ai-key-name") as HTMLInputElement, "Warehouse");
    await click(button("Save"));

    expect(api.createAgentToken).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Warehouse", preset: "read", resource: "dashboard" }),
    );
    const shown = document.querySelector<HTMLInputElement>('input[aria-label="Access key"]');
    expect(shown?.value).toBe(SECRET);
    expect(document.body.textContent).toContain("Copy this key now. You won't see it again.");

    expect(stored(localStorage)).not.toContain(SECRET);
    expect(stored(sessionStorage)).not.toContain(SECRET);
    expect(window.location.href).not.toContain(SECRET);
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(SECRET);
    expect(JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain(SECRET);
    expect(JSON.stringify([toasts.success.mock.calls, toasts.error.mock.calls])).not.toContain(SECRET);

    await click(button("Done"));
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("lets viewers see connections but not create or disconnect them", async () => {
    await render(["agent_access.view"], false);
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex"));
    expect(document.body.textContent).not.toContain("Create access key");
    expect(document.body.textContent).not.toContain("Disconnect all");
  });

  it("renders nothing without access to AI & app access", async () => {
    await render(["settings.general.view"], false);
    expect(host.innerHTML).toBe("");
    expect(api.listAgentConnections).not.toHaveBeenCalled();
  });
});
