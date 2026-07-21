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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

const StatusBadge = React.memo(function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={status === "success" ? "default" : "destructive"}
      className={
        status === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
          : ""
      }
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
    <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-muted-foreground">
        Showing {startItem} to {endItem} of {total} logs
      </div>
      <div className="flex items-center justify-between gap-2 md:hidden">
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {currentPage} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="hidden items-center gap-2 md:flex">
        <Button variant="outline" size="sm" onClick={() => onPageChange(1)} disabled={currentPage === 1}>
          First
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          aria-label="Previous page"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
        >
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
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          aria-label="Next page"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
        >
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
  } = useMetaConversionsLogs();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission(ADMIN_PERMISSIONS.ANALYTICS_EDIT);
  const successfulOnPage = logs.filter((log) => log.status === "success").length;
  const failedOnPage = logs.length - successfulOnPage;

  return (
    <>
      <Card className="shadow-none">
        <CardHeader className="flex flex-col gap-3 pb-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4" />
              Delivery activity
            </CardTitle>
            <CardDescription>
              Meta provider results. Request details are redacted.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={fetchLogs}
              disabled={logsLoading}
            >
              {logsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="h-4 w-4" />
              )}
              Refresh
            </Button>
            {canEdit ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => setManualCleanupDialog(true)}
                  disabled={logsLoading}
                >
                  <Brush className="h-4 w-4" />
                  Remove expired
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => setClearLogsDialog(true)}
                  disabled={logsLoading || logs.length === 0}
                >
                  <Trash2 className="h-4 w-4" />
                  Clear all
                </Button>
              </>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-y py-2 text-xs text-muted-foreground">
            <span>{logsPagination.total} attempts</span>
            <span>{successfulOnPage} succeeded on this page</span>
            <span>{failedOnPage} failed on this page</span>
            {retentionInfo ? (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                Kept for {retentionInfo.days} days
              </span>
            ) : null}
          </div>

          {logsError ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Delivery activity could not be refreshed</AlertTitle>
              <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span>{logsError}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 shrink-0 sm:min-h-9"
                  onClick={fetchLogs}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {logsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          ) : logs.length === 0 && !logsError ? (
            <div className="py-8 text-center text-muted-foreground">
              <Activity className="mx-auto mb-3 h-8 w-8 opacity-50" />
              <p className="text-sm">No delivery attempts yet.</p>
            </div>
          ) : logs.length === 0 ? null : (
            <div className="space-y-4">
              <div className="space-y-3 md:hidden">
                {logs.map((log) => (
                  <article key={log.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-medium">{log.eventName}</h3>
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {log.eventId}
                        </p>
                      </div>
                      <StatusBadge status={log.status} />
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Event time</dt>
                        <dd>{formatDate(log.eventTime)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Recorded</dt>
                        <dd>{formatDate(log.createdAt)}</dd>
                      </div>
                    </dl>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3 min-h-11 w-full"
                      aria-expanded={expandedLog === log.id}
                      onClick={() => toggleExpandLog(log.id)}
                    >
                      {expandedLog === log.id ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                      {expandedLog === log.id
                        ? "Hide redacted details"
                        : "View redacted details"}
                    </Button>
                    {expandedLog === log.id ? <LogDetails log={log} /> : null}
                  </article>
                ))}
              </div>

              <div className="hidden overflow-hidden rounded-lg border md:block">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[300px] min-w-[200px]">Event</TableHead>
                        <TableHead className="w-[120px] min-w-[100px]">Status</TableHead>
                        <TableHead className="w-[180px] min-w-[150px]">Event Time</TableHead>
                        <TableHead className="w-[180px] min-w-[150px]">Created</TableHead>
                        <TableHead className="w-[80px] min-w-[60px]">Details</TableHead>
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
                                size="icon"
                                onClick={() => toggleExpandLog(log.id)}
                                className="h-9 w-9 p-0"
                                aria-label={
                                  expandedLog === log.id
                                    ? `Hide redacted details for ${log.eventName} ${log.eventId}`
                                    : `View redacted details for ${log.eventName} ${log.eventId}`
                                }
                                aria-expanded={expandedLog === log.id}
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
            <AlertDialogTitle>Clear all delivery activity?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes every Meta delivery record. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClearLogs}
              className="bg-destructive hover:bg-destructive/90"
            >
              Clear all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={manualCleanupDialog} onOpenChange={setManualCleanupDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove expired delivery activity?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes records older than {retentionInfo?.days ?? 30} days
              and keeps newer delivery evidence.
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
              Remove expired
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
