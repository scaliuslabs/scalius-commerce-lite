import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { getMetaConversionsLogs, clearMetaConversionsLogs, cleanupMetaConversionsLogs } from "~/lib/api-functions/settings";
import { getServerFnError } from "@/lib/api-helpers";

// Local type replacing @scalius/database/schema import
export interface MetaConversionsLog {
  id: string;
  eventId: string;
  eventName: string;
  status: "success" | "failed";
  requestPayload: string;
  responsePayload: string | null;
  errorMessage: string | null;
  eventTime: Date;
  createdAt: Date;
}

export interface RetentionInfo {
  hours: number;
  cleanupIntervalHours: number;
  nextCleanupMessage: string;
}

interface LogsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useMetaConversionsLogs() {
  const [logs, setLogs] = useState<MetaConversionsLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
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
    try {
      const data = await getMetaConversionsLogs({ data: { page: logsPagination.page, limit: logsPagination.limit } }) as Record<string, unknown>;
      setLogs((data.logs as MetaConversionsLog[]) || []);
      setLogsPagination((prev) => (data.pagination as LogsPagination) || prev);
      setRetentionInfo((data.retention as RetentionInfo) || null);
    } catch {
      toast.error("Failed to load logs");
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
      await clearMetaConversionsLogs();
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
      const data = await cleanupMetaConversionsLogs() as Record<string, unknown>;
      toast.success((data.message as string) || "Manual cleanup completed");
      fetchLogs();
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
