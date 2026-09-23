import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminDiscountsById,
  deleteApiV1AdminDiscountsByIdPermanent,
  postApiV1AdminDiscounts,
  postApiV1AdminDiscountsBulkDelete,
  postApiV1AdminDiscountsByIdRestore,
  postApiV1AdminDiscountsByIdToggleStatus,
  putApiV1AdminDiscountsById,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";
import type { DiscountDto } from "../api-query-options/discounts";

type CreateDiscountInput = ApiBody<typeof postApiV1AdminDiscounts>;
type UpdateDiscountInput = ApiBody<typeof putApiV1AdminDiscountsById>;
import { getServerFnError, queryKeys } from "./shared";
import { readDiscountRevisionConflict } from "../admin-api-error";

type DateTransportValue = string | number | Date;

type DiscountMutationInput = Omit<
  CreateDiscountInput,
  "startDate" | "endDate"
> & {
  startDate: DateTransportValue;
  endDate?: DateTransportValue | null;
};

type UpdateDiscountMutationInput = {
  id: string;
  expectedRevision: number;
} & DiscountMutationInput;

function serializeDateTransport(value: DateTransportValue): string | number {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeOptionalDateTransport(
  value: DateTransportValue | null | undefined,
): string | number | null {
  return value == null ? null : serializeDateTransport(value);
}

function serializeCreateDiscountInput(
  data: DiscountMutationInput,
): CreateDiscountInput {
  return {
    ...data,
    startDate: serializeDateTransport(data.startDate),
    endDate: serializeOptionalDateTransport(data.endDate),
  };
}

function serializeUpdateDiscountInput(
  data: UpdateDiscountMutationInput,
): UpdateDiscountInput {
  return {
    ...data,
    startDate: serializeDateTransport(data.startDate),
    endDate: serializeOptionalDateTransport(data.endDate),
  };
}

export function useCreateDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: DiscountMutationInput) =>
      apiData(postApiV1AdminDiscounts({ body: serializeCreateDiscountInput(data) })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discount created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create discount")),
  });
}

export function useUpdateDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateDiscountMutationInput) =>
      apiData(putApiV1AdminDiscountsById({
        path: { id: data.id },
        body: serializeUpdateDiscountInput(data),
      })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.discounts.detail(variables.id),
      });
      toast.success("Discount updated");
    },
    onError: (err) => {
      if (readDiscountRevisionConflict(err)) return;
      toast.error(getServerFnError(err, "Failed to update discount"));
    },
  });
}

export function useDeleteDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData(deleteApiV1AdminDiscountsById({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.removeQueries({ queryKey: queryKeys.discounts.detail(id) });
      toast.success("Discount moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete discount")),
  });
}

export function usePermanentDeleteDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiData(deleteApiV1AdminDiscountsByIdPermanent({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.removeQueries({ queryKey: queryKeys.discounts.detail(id) });
      toast.success("Discount permanently deleted");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to permanently delete discount"),
      ),
  });
}

export function useRestoreDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData(postApiV1AdminDiscountsByIdRestore({ path: { id } })),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.discounts.detail(id),
      });
      toast.success("Discount restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore discount")),
  });
}

export function useToggleDiscountStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive, expectedRevision }: {
      id: string;
      isActive: boolean;
      expectedRevision: number;
    }) =>
      apiData(postApiV1AdminDiscountsByIdToggleStatus({
        path: { id },
        body: { isActive, expectedRevision },
      })),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.discounts.detail(variables.id),
      });
      const previous = queryClient.getQueryData(
        queryKeys.discounts.detail(variables.id),
      );
      queryClient.setQueryData<DiscountDto | undefined>(
        queryKeys.discounts.detail(variables.id),
        (old) => (old ? { ...old, isActive: variables.isActive } : old),
      );
      return { previous };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<DiscountDto | undefined>(
        queryKeys.discounts.detail(result.id),
        (old) => old ? { ...old, isActive: result.isActive, revision: result.revision } : old,
      );
      toast.success("Discount status updated");
    },
    onError: (err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          queryKeys.discounts.detail(variables.id),
          context.previous,
        );
      }
      if (readDiscountRevisionConflict(err)) {
        toast.warning("Discount changed elsewhere. Loading the latest status.");
      } else {
        toast.error(getServerFnError(err, "Failed to toggle discount status"));
      }
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.discounts.list(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.discounts.detail(variables.id),
      });
    },
  });
}

export function useBulkDeleteDiscounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      discountIds?: string[];
      ids?: string[];
      permanent?: boolean;
    }) =>
      apiData(postApiV1AdminDiscountsBulkDelete({
        body: {
          discountIds: data.discountIds ?? data.ids ?? [],
          permanent: data.permanent,
        },
      })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discounts deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete discounts")),
  });
}
