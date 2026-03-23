import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Activity,
  Trash2,
  Loader2,
  CheckCircle,
  AlertCircle,
  RotateCcw,
  Clock,
  Brush,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useMetaConversionsLogs } from "./hooks/useMetaConversionsLogs";
import { LogDetails } from "./LogDetails";
import { formatDate } from "@scalius/shared/timestamps";

const StatusBadge = React.memo(function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={status === "success" ? "default" : "destructive"}
      className={status === "success" ? "bg-green-100 text-green-800" : ""}
    >
      {status === "success" ? (
        <CheckCircle className="w-3 h-3 mr-1" />
      ) : (
        <AlertCircle className="w-3 h-3 mr-1" />
      )}
      {status === "success" ? "Success" : "Failed"}
    </Badge>
  );
});

interface PaginationProps {
  pagination: { page: number; limit: number; total: number; totalPages: number };
  onPageChange: (page: number) => void;
}

function Pagination({ pagination, onPageChange }: PaginationProps) {
  const { page: currentPage, limit, total, totalPages } = pagination;

  if (totalPages <= 1) return null;

  const maxVisiblePages = 5;
  const halfVisible = Math.floor(maxVisiblePages / 2);

  let startPage = Math.max(1, currentPage - halfVisible);
  const endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

  if (endPage - startPage + 1 < maxVisiblePages) {
    startPage = Math.max(1, endPage - maxVisiblePages + 1);
  }

  const visiblePages = Array.from(
    { length: endPage - startPage + 1 },
    (_, i) => startPage + i,
  );

  const startItem = Math.min((currentPage - 1) * limit + 1, total);
  const endItem = Math.min(currentPage * limit, total);

  return (
    <div className="flex items-center justify-between mt-4">
      <div className="text-sm text-muted-foreground">
        Showing {startItem} to {endItem} of {total} logs
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onPageChange(1)} disabled={currentPage === 1}>
          First
        </Button>
        <Button variant="outline" size="sm" onClick={() => onPageChange(currentPage - 1)} disabled={currentPage === 1}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        {visiblePages.map((pageNum) => (
          <Button
            key={pageNum}
            variant={pageNum === currentPage ? "default" : "outline"}
            size="sm"
            onClick={() => onPageChange(pageNum)}
          >
            {pageNum}
          </Button>
        ))}
        <Button variant="outline" size="sm" onClick={() => onPageChange(currentPage + 1)} disabled={currentPage === totalPages}>
          <ChevronRight className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onPageChange(totalPages)} disabled={currentPage === totalPages}>
          Last
        </Button>
      </div>
    </div>
  );
}

export function MetaConversionsLogs() {
  const {
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
  } = useMetaConversionsLogs();

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5" />
              Meta Conversions Logs
            </CardTitle>
            <CardDescription>
              View and manage Meta Conversions API event logs.
              {retentionInfo && (
                <span className="block mt-2 text-sm">
                  <Clock className="w-4 h-4 inline mr-1" />
                  {retentionInfo.nextCleanupMessage}
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchLogs} disabled={logsLoading}>
              {logsLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RotateCcw className="w-4 h-4" />
              )}
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => setManualCleanupDialog(true)} disabled={logsLoading}>
              <Brush className="w-4 h-4 mr-2" />
              Manual Cleanup
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setClearLogsDialog(true)} disabled={logsLoading || logs.length === 0}>
              <Trash2 className="w-4 h-4 mr-2" />
              Clear All
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Activity className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No logs available</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border overflow-hidden">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[300px] min-w-[200px]">Event</TableHead>
                        <TableHead className="w-[120px] min-w-[100px]">Status</TableHead>
                        <TableHead className="w-[180px] min-w-[150px]">Event Time</TableHead>
                        <TableHead className="w-[180px] min-w-[150px]">Created</TableHead>
                        <TableHead className="w-[80px] min-w-[60px]">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logs.map((log) => (
                        <React.Fragment key={log.id}>
                          <TableRow>
                            <TableCell className="max-w-[300px]">
                              <div className="space-y-1">
                                <div className="font-medium truncate">{log.eventName}</div>
                                <div className="text-sm text-muted-foreground truncate">ID: {log.eventId}</div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <StatusBadge status={log.status} />
                            </TableCell>
                            <TableCell className="text-sm">{formatDate(log.eventTime)}</TableCell>
                            <TableCell className="text-sm">{formatDate(log.createdAt)}</TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleExpandLog(log.id)}
                                className="h-8 w-8 p-0"
                              >
                                {expandedLog === log.id ? (
                                  <ChevronUp className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                          {expandedLog === log.id && (
                            <TableRow>
                              <TableCell colSpan={5} className="border-t-0 p-0">
                                <LogDetails log={log} />
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <Pagination
                pagination={logsPagination}
                onPageChange={handlePageChange}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={clearLogsDialog} onOpenChange={setClearLogsDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear All Logs</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to clear all Meta Conversions logs? This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearLogs}
              className="bg-destructive hover:bg-destructive/90"
            >
              Clear Logs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={manualCleanupDialog} onOpenChange={setManualCleanupDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Manual Log Cleanup</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove logs older than {retentionInfo?.hours || 12}{" "}
              hours. Are you sure you want to proceed?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleManualCleanup} disabled={isManualCleanupLoading}>
              {isManualCleanupLoading ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Brush className="w-4 h-4 mr-2" />
              )}
              Cleanup Now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
