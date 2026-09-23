import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import {
  deleteApiV1AdminSettingsMetaConversionsLogs,
  getApiV1AdminSettingsMetaConversionsLogs,
  postApiV1AdminSettingsMetaConversionsLogs,
} from "@scalius/api-client/sdk";
import { apiData, type ApiResult } from "~/lib/api";

type LogsPayload = ApiResult<typeof getApiV1AdminSettingsMetaConversionsLogs>;
type LogsPagination = LogsPayload["pagination"];
export type RetentionInfo = LogsPayload["retention"];
// The contract renders these nullable timestamp unions as `unknown`; the API
// sends `string | number | null`.
export type MetaConversionsLog = Omit<LogsPayload["logs"][number], "eventTime" | "createdAt"> & {
  eventTime: string | number | null;
  createdAt: string | number | null;
};

export function useMetaConversionsLogs() {
  const [logs, setLogs] = useState<MetaConversionsLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsPagination, setLogsPagination] = useState<LogsPagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [retentionInfo, setRetentionInfo] = useState<RetentionInfo | null>(null);
  const [clearLogsDialog, setClearLogsDialog] = useState(false);
  const [manualCleanupDialog, setManualCleanupDialog] = useState(false);
  const [isManualCleanupLoading, setIsManualCleanupLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const data = await apiData(getApiV1AdminSettingsMetaConversionsLogs({
        query: { page: logsPagination.page, limit: logsPagination.limit },
      }));
      setLogs(data.logs as MetaConversionsLog[]);
      setLogsPagination(data.pagination);
      setRetentionInfo(data.retention);
    } catch (error: unknown) {
      const message = getServerFnError(error, "Failed to load delivery activity");
      setLogsError(message);
      toast.error(message);
    } finally {
      setLogsLoading(false);
    }
  }, [logsPagination.page, logsPagination.limit]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  const handleClearLogs = async () => {
    setLogsLoading(true);
    try {
      await apiData(deleteApiV1AdminSettingsMetaConversionsLogs());
      setLogs([]);
      setLogsPagination((prev) => ({
        ...prev,
        total: 0,
        totalPages: 1,
      }));
      toast.success("Logs cleared successfully");
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to clear logs"));
    } finally {
      setLogsLoading(false);
      setClearLogsDialog(false);
    }
  };

  const handleManualCleanup = async () => {
    setIsManualCleanupLoading(true);
    try {
      const data = await apiData(postApiV1AdminSettingsMetaConversionsLogs()) as Record<string, unknown>;
      toast.success((data.message as string) || "Manual cleanup completed");
      await fetchLogs();
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to perform manual cleanup"));
    } finally {
      setIsManualCleanupLoading(false);
      setManualCleanupDialog(false);
    }
  };

  const handlePageChange = (newPage: number) => {
    setLogsPagination((prev) => ({ ...prev, page: newPage }));
  };

  const toggleExpandLog = (logId: string) => {
    setExpandedLog((prev) => (prev === logId ? null : logId));
  };

  return {
    logs,
    logsLoading,
    logsError,
    logsPagination,
    expandedLog,
    retentionInfo,
    clearLogsDialog,
    setClearLogsDialog,
    manualCleanupDialog,
    setManualCleanupDialog,
    isManualCleanupLoading,
    fetchLogs,
    handleClearLogs,
    handleManualCleanup,
    handlePageChange,
    toggleExpandLog,
  };
}
