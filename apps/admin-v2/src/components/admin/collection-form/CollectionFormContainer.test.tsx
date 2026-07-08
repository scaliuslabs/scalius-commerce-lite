// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { CollectionForm } from "./CollectionFormContainer";
import type { Category, CollectionFormValues, Product } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const collectionApi = vi.hoisted(() => ({
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
}));

const productApi = vi.hoisted(() => ({
  getProducts: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  proceed: vi.fn(),
  reset: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("~/lib/api-functions/collections", () => collectionApi);

vi.mock("~/lib/api-functions/products", () => productApi);

vi.mock("sonner", () => ({
  toast: toastMock,
}));

vi.mock("~/components/admin/shared/UnsavedChangesGuard", () => ({
  UnsavedChangesGuard: () => null,
}));

vi.mock("~/components/admin/FormStickyHeader", () => ({
  FormActionBar: ({
    isSubmitting,
    onSave,
  }: {
    isSubmitting: boolean;
    onSave: () => void;
  }) => (
    <button type="button" disabled={isSubmitting} onClick={onSave}>
      Save Collection
    </button>
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerMocks.navigate,
  useBlocker: () => ({
    proceed: routerMocks.proceed,
    reset: routerMocks.reset,
    status: "idle",
  }),
  Link: ({
    to,
    children,
    disabled: _disabled,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("~/components/admin/shared/ResourceDiscoveryReadiness", () => ({
  ResourceDiscoveryReadiness: () => <div data-testid="discovery-readiness" />,
}));

const categories: Category[] = [
  { id: "cat_curated", name: "Curated Picks" },
];

const collectionDefaults: Partial<CollectionFormValues> = {
  id: "col_late_labels",
  name: "Late Label Collection",
  type: "manual",
  isActive: true,
  canonicalPath: "/collections/col_late_labels",
  noIndex: false,
  excludeFromSitemap: false,
  config: {
    categoryIds: ["cat_curated"],
    productIds: ["prod_primary", "prod_secondary"],
    featuredProductId: "prod_featured",
    maxProducts: 8,
    title: "Buyer-facing title",
    subtitle: "Buyer-facing subtitle",
  },
};

const productLabels: Product[] = [
  { id: "prod_primary", name: "Primary Linen Shirt", categoryId: "cat_curated" },
  {
    id: "prod_secondary",
    name: "Secondary Cotton Sari",
    categoryId: "cat_curated",
  },
  {
    id: "prod_featured",
    name: "Featured Jamdani Set",
    categoryId: "cat_curated",
  },
];

async function flushAsyncWork() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushAsyncWork();
    }
  }

  throw lastError;
}

function getButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) =>
    normalizeText(candidate.textContent).includes(label),
  );
  if (!button) throw new Error(`Expected button labeled ${label}`);
  return button;
}

function getInputByPlaceholder(
  host: HTMLElement,
  placeholder: string,
): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  );
  if (!input) throw new Error(`Expected input with placeholder ${placeholder}`);
  return input;
}

function normalizeText(value: string | null) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

describe("CollectionForm edit product labels", () => {
  let host: HTMLDivElement;
  let appHost: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    host = document.createElement("div");
    appHost = document.createElement("div");
    const actionBarHost = document.createElement("div");
    actionBarHost.id = "form-action-bar-slot";
    host.append(appHost, actionBarHost);
    document.body.append(host);
    root = createRoot(appHost);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    collectionApi.createCollection.mockResolvedValue({ id: "col_new" });
    collectionApi.updateCollection.mockResolvedValue({ id: "col_late_labels" });
    productApi.getProducts.mockResolvedValue({
      products: [],
      pagination: { totalPages: 1, total: 0 },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
  });

  async function renderCollectionForm(products: Product[]) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CollectionForm
            categories={categories}
            products={products}
            defaultValues={collectionDefaults}
            isEdit
          />
        </QueryClientProvider>,
      );
    });
  }

  it("keeps edit product ids hidden until labels arrive and submits canonical ids", async () => {
    await renderCollectionForm([]);

    await waitFor(() => {
      expect(host.textContent).toContain("Save Collection");
    });

    expect(getButton(host, "Save Collection").disabled).toBe(false);
    expect(getInputByPlaceholder(host, "Collection name").value).toBe(
      "Late Label Collection",
    );
    expect(host.textContent).toContain("Curated Picks");
    expect(host.textContent).not.toContain("prod_primary");
    expect(host.textContent).not.toContain("prod_secondary");
    expect(host.textContent).not.toContain("prod_featured");

    await renderCollectionForm(productLabels);

    await waitFor(() => {
      expect(host.textContent).toContain("Primary Linen Shirt");
      expect(host.textContent).toContain("Secondary Cotton Sari");
      expect(host.textContent).toContain("Featured Jamdani Set");
    });

    expect(host.textContent).not.toContain("prod_primary");
    expect(host.textContent).not.toContain("prod_secondary");
    expect(host.textContent).not.toContain("prod_featured");

    await act(async () => {
      getButton(host, "Save Collection").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    await waitFor(() => {
      expect(collectionApi.updateCollection).toHaveBeenCalledTimes(1);
    });

    const payload = collectionApi.updateCollection.mock.calls[0]?.[0]?.data;
    expect(payload).toEqual(
      expect.objectContaining({
        id: "col_late_labels",
        config: expect.objectContaining({
          categoryIds: ["cat_curated"],
          productIds: ["prod_primary", "prod_secondary"],
          featuredProductId: "prod_featured",
        }),
      }),
    );
    expect(payload.config.productIds.every((id: unknown) => typeof id === "string")).toBe(
      true,
    );
    expect(typeof payload.config.featuredProductId).toBe("string");
    expect(collectionApi.createCollection).not.toHaveBeenCalled();
  });
});
