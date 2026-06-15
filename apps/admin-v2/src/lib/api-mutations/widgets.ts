import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteWidgets,
  bulkRestoreWidgets,
  createWidget,
  createWidgetHistorySnapshot,
  deleteWidget,
  deleteWidgetHistory,
  permanentDeleteWidget,
  restoreWidget,
  restoreWidgetHistory,
  updateWidget,
  type BulkDeleteWidgetsInput,
  type CreateWidgetHistorySnapshotInput,
  type CreateWidgetInput,
  type DeleteWidgetHistoryInput,
  type RestoreWidgetHistoryInput,
  type UpdateWidgetInput,
} from "../api-functions/widgets";
import { getServerFnError, queryKeys } from "./shared";

export function useCreateWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWidgetInput) => createWidget({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      toast.success("Widget created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create widget")),
  });
}

export function useUpdateWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateWidgetInput) => updateWidget({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.detail(variables.id),
      });
      toast.success("Widget updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update widget")),
  });
}

export function useDeleteWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWidget({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      queryClient.removeQueries({ queryKey: queryKeys.widgets.detail(id) });
      toast.success("Widget moved to trash");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete widget")),
  });
}

export function usePermanentDeleteWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => permanentDeleteWidget({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      queryClient.removeQueries({ queryKey: queryKeys.widgets.detail(id) });
      toast.success("Widget permanently deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to permanently delete widget")),
  });
}

export function useRestoreWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreWidget({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.detail(id) });
      toast.success("Widget restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore widget")),
  });
}

export function useBulkDeleteWidgets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: BulkDeleteWidgetsInput) => bulkDeleteWidgets({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      toast.success(
        variables.permanent
          ? `${variables.ids.length} widgets permanently deleted`
          : `${variables.ids.length} widgets moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete widgets")),
  });
}

export function useBulkRestoreWidgets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => bulkRestoreWidgets({ data: { ids } }),
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.widgets.list() });
      toast.success(`${ids.length} widgets restored`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore widgets")),
  });
}

export function useCreateWidgetHistorySnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateWidgetHistorySnapshotInput) =>
      createWidgetHistorySnapshot({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.history(variables.widgetId),
      });
      toast.success("History snapshot created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create history snapshot")),
  });
}

export function useDeleteWidgetHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: DeleteWidgetHistoryInput) => deleteWidgetHistory({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.history(variables.widgetId),
      });
      toast.success("History entry deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete history entry")),
  });
}

export function useRestoreWidgetHistory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: RestoreWidgetHistoryInput) =>
      restoreWidgetHistory({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.history(variables.widgetId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.widgets.detail(variables.widgetId),
      });
      toast.success("Widget restored from history");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore from history")),
  });
}
