// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { writeListSearch } from "~/lib/list-search";

const mocks = vi.hoisted(() => ({ locations: vi.fn(), transfers: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => () => undefined,
}));
vi.mock("~/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("~/hooks/use-catalog-action-permissions", () => ({
  useCatalogActionPermissions: () => ({ inventory: { canManageOperations: true } }),
}));
vi.mock("~/lib/api", () => ({ apiData: (call: Promise<unknown>) => call }));
vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1AdminInventoryLocations: mocks.locations,
  getApiV1AdminInventoryTransfers: mocks.transfers,
}));

import { DocumentList } from "./DocumentList";
import { TransferList } from "./TransferList";
import type { TransferTab } from "./purchasing-list-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const t = (key: keyof typeof purchasingMessages.en) => translate(purchasingMessages, key);
const location = (id: string) => ({ id, name: id, status: "active", isDefault: id === "loc_1" });
const empty = { transfers: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } };

describe("transfer location prerequisite", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    writeListSearch("transfers", "");
    mocks.locations.mockResolvedValue({ locations: [location("loc_1")] });
    mocks.transfers.mockResolvedValue(empty);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
    writeListSearch("transfers", "");
    vi.clearAllMocks();
  });

  async function render(tab: TransferTab = "all", node?: ReactNode) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        {node ?? <TransferList tab={tab} onTabChange={() => undefined} />}
      </QueryClientProvider>,
    ));
  }
  const locationLinks = () => host.querySelectorAll('a[href="/admin/settings/locations"]');
  const notice = () => host.querySelector('[data-slot="alert"]');
  const firstUse = () => host.querySelector('[data-state-kind="first-use"]');

  it.each([0, 1])("offers one prerequisite card and action with %s active locations", async (count) => {
    mocks.locations.mockResolvedValue({ locations: Array.from({ length: count }, (_, index) => location(`loc_${index + 1}`)) });
    await render();
    await vi.waitFor(() => expect(firstUse()?.textContent).toContain(t("needTwoLocations")));
    expect(notice()).toBeNull();
    expect(locationLinks()).toHaveLength(1);
    expect(firstUse()?.querySelector("h2")?.textContent).toBe(t("addLocation"));
    expect(host.textContent).not.toContain(t("emptyTransfersTitle"));
    expect(host.textContent).not.toContain(t("createTransfer"));
    expect(host.querySelector('[role="tablist"]')).toBeNull();
  });

  it("keeps the normal first-transfer action once two locations exist", async () => {
    mocks.locations.mockResolvedValue({ locations: [location("loc_1"), location("loc_2")] });
    await render();
    await vi.waitFor(() => expect(firstUse()?.textContent).toContain(t("emptyTransfersTitle")));
    expect(notice()).toBeNull();
    expect(locationLinks()).toHaveLength(0);
    expect(firstUse()?.querySelector('a[href="/admin/inventory/transfers/new"]')?.textContent).toBe(t("createTransfer"));
  });

  it("keeps the location notice beside existing transfers", async () => {
    mocks.transfers.mockResolvedValue({
      transfers: [{
        id: "tr_1", displayNumber: "T1001", status: "draft", origin: location("loc_1"), destination: location("loc_2"),
        quantity: 4, inTransitQuantity: 0, receivedQuantity: 0, expectedOn: null, createdAt: 1_700_000_000,
      }],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
    });
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("T1001"));
    expect(notice()?.textContent).toContain(t("needTwoLocations"));
    expect(locationLinks()).toHaveLength(1);
    expect(firstUse()).toBeNull();
  });

  it.each(["search", "tab"])("keeps the notice when an empty list is narrowed by %s", async (mode) => {
    if (mode === "search") writeListSearch("transfers", "missing");
    await render(mode === "tab" ? "open" : "all");
    await vi.waitFor(() => expect(host.querySelector('[data-state-kind="filtered"]')).not.toBeNull());
    expect(notice()?.textContent).toContain(t("needTwoLocations"));
    expect(locationLinks()).toHaveLength(1);
    expect(firstUse()).toBeNull();
  });

  it.each(["loading", "error"])("keeps the notice while transfer data is %s", async (state) => {
    if (state === "loading") mocks.transfers.mockImplementation(() => new Promise(() => undefined));
    else mocks.transfers.mockRejectedValue(new Error("Transfers unavailable"));
    await render();
    await vi.waitFor(() => expect(notice()?.textContent).toContain(t("needTwoLocations")));
    if (state === "error") await vi.waitFor(() => expect(host.querySelector('[data-slot="error-state"]')).not.toBeNull());
    expect(locationLinks()).toHaveLength(1);
    expect(firstUse()).toBeNull();
  });

  it("preserves other DocumentList notices unless the caller opts in", async () => {
    await render("all", <DocumentList<{ id: string }, "all">
      title="Documents" notice={<div role="alert">Existing notice</div>}
      tabs={[{ value: "all", label: "All" }]} tab="all" onTabChange={() => undefined}
      searchKey="document-list-notice-test" searchPlaceholder="Search documents"
      query={() => ({ queryKey: ["empty-documents"], queryFn: async () => ({ documents: [], pagination: empty.pagination }) })}
      dataKey="documents" columns={[]} layoutKey="document-list-notice-test" itemLabel="documents"
      empty={{ icon: ArrowLeftRight, title: "First document", description: "Create one" }}
    />);
    await vi.waitFor(() => expect(firstUse()?.textContent).toContain("First document"));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Existing notice");
  });
});
