import { beforeEach, describe, expect, it, vi } from "vitest";

const reactQueryMocks = vi.hoisted(() => {
  const queryClient = {
    cancelQueries: vi.fn(async () => undefined),
    getQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  };

  return {
    queryClient,
    useMutation: vi.fn((options: unknown) => options),
    useQueryClient: vi.fn(() => queryClient),
  };
});

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: reactQueryMocks.useMutation,
  useQueryClient: reactQueryMocks.useQueryClient,
}));

vi.mock("sonner", () => ({ toast: toastMocks }));

vi.mock("../api-functions/discounts", () => ({
  bulkDeleteDiscounts: vi.fn(),
  bulkRestoreDiscounts: vi.fn(),
  createDiscount: vi.fn(),
  deleteDiscount: vi.fn(),
  permanentDeleteDiscount: vi.fn(),
  restoreDiscount: vi.fn(),
  toggleDiscountStatus: vi.fn(),
  updateDiscount: vi.fn(),
}));

import { AdminApiResponseError } from "../admin-api-error";
import { queryKeys } from "../query-keys";
import { useToggleDiscountStatus } from "./discounts";

type ToggleVariables = {
  id: string;
  isActive: boolean;
  expectedRevision: number;
};

type ToggleMutationOptions = {
  onError?: (
    error: unknown,
    variables: ToggleVariables,
    context?: { previous?: unknown },
  ) => void;
  onSettled?: (
    data: unknown,
    error: unknown,
    variables: ToggleVariables,
  ) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discount status mutation recovery", () => {
  it("restores the optimistic detail snapshot and refreshes the stale list after a revision conflict", () => {
    const mutation = useToggleDiscountStatus() as ToggleMutationOptions;
    const variables = {
      id: "disc_1",
      isActive: true,
      expectedRevision: 3,
    };
    const previous = {
      id: "disc_1",
      isActive: false,
      revision: 3,
    };
    const conflict = new AdminApiResponseError(
      "Discount changed",
      409,
      "DISCOUNT_REVISION_CONFLICT",
      { expectedRevision: 3, currentRevision: 4 },
    );

    mutation.onError?.(conflict, variables, { previous });
    mutation.onSettled?.(undefined, conflict, variables);

    expect(reactQueryMocks.queryClient.setQueryData).toHaveBeenCalledWith(
      queryKeys.discounts.detail("disc_1"),
      previous,
    );
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.discounts.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.discounts.detail("disc_1"),
    });
    expect(toastMocks.warning).toHaveBeenCalledWith(
      "Discount changed elsewhere. Loading the latest status.",
    );
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});
