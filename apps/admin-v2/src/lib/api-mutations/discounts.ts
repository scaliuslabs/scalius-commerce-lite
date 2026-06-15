import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteDiscounts,
  bulkRestoreDiscounts,
  createDiscount,
  deleteDiscount,
  permanentDeleteDiscount,
  restoreDiscount,
  toggleDiscountStatus,
  updateDiscount,
  type CreateDiscountInput,
  type DiscountDto,
  type UpdateDiscountInput,
} from "../api-functions/discounts";
import { getServerFnError, queryKeys } from "./shared";

type DateTransportValue = string | number | Date;

type DiscountMutationInput = Omit<
  CreateDiscountInput,
  "startDate" | "endDate"
> & {
  startDate: DateTransportValue;
  endDate?: DateTransportValue | null;
};

type UpdateDiscountMutationInput = { id: string } & DiscountMutationInput;

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
      createDiscount({ data: serializeCreateDiscountInput(data) }),
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
      updateDiscount({ data: serializeUpdateDiscountInput(data) }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.discounts.detail(variables.id),
      });
      toast.success("Discount updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update discount")),
  });
}

export function useDeleteDiscount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDiscount({ data: { id } }),
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
    mutationFn: (id: string) => permanentDeleteDiscount({ data: { id } }),
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
    mutationFn: (id: string) => restoreDiscount({ data: { id } }),
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
    mutationFn: (data: { id: string; isActive: boolean }) =>
      toggleDiscountStatus({ data }),
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discount status updated");
    },
    onError: (err, variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          queryKeys.discounts.detail(variables.id),
          context.previous,
        );
      }
      toast.error(getServerFnError(err, "Failed to toggle discount status"));
    },
    onSettled: (_data, _err, variables) => {
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
      bulkDeleteDiscounts({
        data: {
          discountIds: data.discountIds ?? data.ids ?? [],
          permanent: data.permanent,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discounts deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete discounts")),
  });
}

export function useBulkRestoreDiscounts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { discountIds?: string[]; ids?: string[] }) =>
      bulkRestoreDiscounts({
        data: { discountIds: data.discountIds ?? data.ids ?? [] },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.discounts.list() });
      toast.success("Discounts restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore discounts")),
  });
}
