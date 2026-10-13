// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ updateCard: vi.fn(), updateOrder: vi.fn(), createOrder: vi.fn(), announce: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => ({
  patchApiV1AdminGiftCardsByGiftCardId: api.updateCard,
  putApiV1AdminInventoryPurchaseOrdersByPurchaseOrderId: api.updateOrder,
  postApiV1AdminInventoryPurchaseOrders: api.createOrder,
}));
vi.mock("~/lib/realtime/store", () => ({ announceSave: api.announce, presenceKey: (prefix: string, id: string) => `${prefix}:${id}` }));

import { useUpdateGiftCard } from "~/components/admin/gift-cards/use-gift-card-mutations";
import { useSavePurchaseOrder } from "~/lib/api-query-options/purchasing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
let saveCard: ReturnType<typeof useUpdateGiftCard>["mutateAsync"];
let saveOrder: ReturnType<typeof useSavePurchaseOrder>["mutateAsync"];

function Editor() {
  saveCard = useUpdateGiftCard("gc_1").mutateAsync;
  saveOrder = useSavePurchaseOrder().mutateAsync;
  return null;
}

const response = (data: unknown) => ({ data: { success: true, data } });

beforeEach(async () => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><Editor /></QueryClientProvider>));
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});

describe("saved record presence notices", () => {
  it("announces the returned gift-card version, never its monetary or contact data", async () => {
    api.updateCard.mockResolvedValue(response({ giftCard: { id: "gc_1", version: 12, balanceMinor: 49000, recipientEmail: "private@example.test" } }));
    await act(async () => { await saveCard({ version: 8, status: "disabled" }); });
    expect(api.announce).toHaveBeenCalledExactlyOnceWith("gift-card:gc_1", 12);
  });

  it("does not announce a refused or failed save", async () => {
    api.updateCard.mockRejectedValue(new Error("Version conflict"));
    await act(async () => { await expect(saveCard({ version: 8, status: "disabled" })).rejects.toThrow("Version conflict"); });
    expect(api.announce).not.toHaveBeenCalled();
  });

  it("keeps new drafts out of presence and uses the server revision after editing", async () => {
    const body = {} as Parameters<typeof saveOrder>[0]["body"];
    api.createOrder.mockResolvedValue(response({ id: "po_new", revision: 1 }));
    await act(async () => { await saveOrder({ id: null, revision: null, body }); });
    expect(api.announce).not.toHaveBeenCalled();
    api.updateOrder.mockResolvedValue(response({ id: "po_new", revision: 9 }));
    await act(async () => { await saveOrder({ id: "po_new", revision: 3, body }); });
    expect(api.announce).toHaveBeenCalledExactlyOnceWith("purchase-order:po_new", 9);
  });
});
