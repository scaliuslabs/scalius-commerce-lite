import { beforeEach, describe, expect, it, vi } from "vitest";

const reactQueryMocks = vi.hoisted(() => {
  const queryClient = {
    invalidateQueries: vi.fn(),
    removeQueries: vi.fn(),
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

const apiMocks = vi.hoisted(() => ({
  activatePromotion: vi.fn(),
  createPromotion: vi.fn(),
  deletePromotion: vi.fn(),
  pausePromotion: vi.fn(),
  previewPromotion: vi.fn(),
  updatePromotion: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: reactQueryMocks.useMutation,
  useQueryClient: reactQueryMocks.useQueryClient,
}));

vi.mock("sonner", () => ({ toast: toastMocks }));
vi.mock("../api-functions/promotions", () => apiMocks);

import { AdminApiResponseError } from "../admin-api-error";
import { queryKeys } from "../query-keys";
import {
  useActivatePromotion,
  useDeletePromotion,
  usePreviewPromotion,
  useUpdatePromotion,
} from "./promotions";

type MutationOptions = {
  mutationFn?: (variables: never) => unknown;
  onSuccess?: (result: unknown, variables: { id: string }) => void;
  onError?: (error: unknown, variables: { id: string }) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("promotion mutations", () => {
  it("submits a revisioned replacement and refreshes list and aggregate", () => {
    const mutation = useUpdatePromotion() as MutationOptions;
    const variables = {
      id: "promo_1",
      input: {
        expectedRevision: 3,
        name: "Launch offer",
        method: "code",
        codes: [{ code: "LAUNCH10", isActive: true }],
        effects: [
          {
            kind: "percentage_off",
            target: "order",
            allocation: "once",
            config: { basisPoints: 1_000 },
          },
        ],
      },
    };

    mutation.mutationFn?.(variables as never);
    mutation.onSuccess?.({}, variables);

    expect(apiMocks.updatePromotion).toHaveBeenCalledWith({
      data: { id: variables.id, ...variables.input },
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.promotions.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.promotions.detail("promo_1"),
    });
    expect(toastMocks.success).toHaveBeenCalledWith("Promotion saved");
  });

  it("keeps deterministic preview side-effect free", () => {
    const mutation = usePreviewPromotion() as MutationOptions;
    const variables = {
      id: "promo_1",
      expectedRevision: 3,
      cart: {
        currencyCode: "BDT",
        lines: [],
        shippingAmountMinor: 0,
        submittedCodes: ["LAUNCH10"],
        evaluatedAtEpochSeconds: 1_800_000_000,
      },
    };

    mutation.mutationFn?.(variables as never);
    mutation.onSuccess?.({}, variables);

    expect(apiMocks.previewPromotion).toHaveBeenCalledWith({ data: variables });
    expect(reactQueryMocks.queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("reloads revision-sensitive projections after a conflict", () => {
    const mutation = useActivatePromotion() as MutationOptions;
    const variables = { id: "promo_1", expectedRevision: 3 };
    const conflict = new AdminApiResponseError(
      "Promotion changed",
      409,
      "PROMOTION_REVISION_CONFLICT",
      { expectedRevision: 3, currentRevision: 4 },
    );

    mutation.onError?.(conflict, variables);

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.promotions.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.promotions.detail("promo_1"),
    });
    expect(toastMocks.warning).toHaveBeenCalledWith(
      "Promotion changed elsewhere. Loading the latest version.",
    );
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("archives with a revision claim and removes the unreadable detail", () => {
    const mutation = useDeletePromotion() as MutationOptions;
    const variables = { id: "promo_1", expectedRevision: 6 };

    mutation.mutationFn?.(variables as never);
    mutation.onSuccess?.(undefined, variables);

    expect(apiMocks.deletePromotion).toHaveBeenCalledWith({ data: variables });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.promotions.list(),
    });
    expect(reactQueryMocks.queryClient.removeQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.promotions.detail("promo_1"),
    });
    expect(toastMocks.success).toHaveBeenCalledWith("Promotion archived");
  });
});
