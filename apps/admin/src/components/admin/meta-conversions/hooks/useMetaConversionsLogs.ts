import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";

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
      const params = new URLSearchParams({
        page: String(logsPagination.page),
        limit: String(logsPagination.limit),
      });
      const response = await fetch(
        `/api/v1/admin/settings/meta-conversions/logs?${params}`,
      );
      if (response.ok) {
        const json = await response.json();
        const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
        setLogs(data.logs || []);
        setLogsPagination((prev) => data.pagination || prev);
        setRetentionInfo(data.retention || null);
      }
    } catch {
      toast.error("Failed to load logs");
    } finally {
      setLogsLoading(false);
    }
  }, [logsPagination.page, logsPagination.limit]);

  useEffect(() => {
    fetchLogs();
  }, [logsPagination.page, logsPagination.limit]);

  const handleClearLogs = async () => {
    setLogsLoading(true);
    try {
      const response = await fetch(
        "/api/v1/admin/settings/meta-conversions/logs",
        { method: "DELETE" },
      );

      if (!response.ok) throw new Error("Failed to clear logs");

      setLogs([]);
      setLogsPagination((prev) => ({
        ...prev,
        total: 0,
        totalPages: 1,
      }));
      toast.success("Logs cleared successfully");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to clear logs";
      toast.error(msg);
    } finally {
      setLogsLoading(false);
      setClearLogsDialog(false);
    }
  };

  const handleManualCleanup = async () => {
    setIsManualCleanupLoading(true);
    try {
      const response = await fetch(
        "/api/v1/admin/settings/meta-conversions/logs",
        { method: "POST" },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to perform manual cleanup");
      }

      const json = await response.json();
      const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? json.data : json;
      toast.success(data.message || "Manual cleanup completed");
      fetchLogs();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Failed to perform manual cleanup";
      toast.error(msg);
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
