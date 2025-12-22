// src/components/admin/MetaConversionsManager.tsx
import React, { useState, useEffect, useCallback } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  Settings,
  Activity,
  Trash2,
  Loader2,
  Eye,
  EyeOff,
  CheckCircle,
  AlertCircle,
  Save,
  RotateCcw,
  Clock,
  Brush,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { toast } from "sonner";
import type { MetaConversionsSettings, MetaConversionsLog } from "@/db/schema";

interface MetaConversionsManagerProps {
  initialSettings?: MetaConversionsSettings;
}

interface LogEntry extends MetaConversionsLog {}

interface RetentionInfo {
  hours: number;
  cleanupIntervalHours: number;
  nextCleanupMessage: string;
}

interface FormData {
  pixelId: string;
  accessToken: string;
  testEventCode: string;
  isEnabled: boolean;
  logRetentionDays: number;
}

interface LogsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const DEFAULT_FORM_DATA: FormData = {
  pixelId: "",
  accessToken: "",
  testEventCode: "",
  isEnabled: false,
  logRetentionDays: 30,
};

// Utility function to safely parse JSON
const safeJsonParse = (jsonString: string): any => {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.error("Invalid JSON:", error);
    return { error: "Invalid JSON format" };
  }
};

// Utility function to format dates safely
const formatDate = (timestamp: string | number | Date | null): string => {
  if (!timestamp) return "Invalid Date";
  try {
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? "Invalid Date" : date.toLocaleString();
  } catch (e) {
    return "Invalid Date";
  }
};

// Status badge component
const StatusBadge: React.FC<{ status: string }> = ({ status }) => (
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

// Pagination component
const Pagination: React.FC<{
  pagination: LogsPagination;
  onPageChange: (page: number) => void;
}> = ({ pagination, onPageChange }) => {
  const { page: currentPage, limit, total, totalPages } = pagination;

  if (totalPages <= 1) return null;

  // Calculate visible pages (max 5)
  const maxVisiblePages = 5;
  const halfVisible = Math.floor(maxVisiblePages / 2);

  let startPage = Math.max(1, currentPage - halfVisible);
  let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

  // Adjust if we're near the end
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(1)}
          disabled={currentPage === 1}
        >
          First
        </Button>
        <Button
          variant="outline"
          size="sm"
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
          size="sm"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(totalPages)}
          disabled={currentPage === totalPages}
        >
          Last
        </Button>
      </div>
    </div>
  );
};

// Log details component
const LogDetails: React.FC<{ log: LogEntry }> = ({ log }) => (
  <div className="p-4 bg-muted/50 rounded-lg space-y-4">
    <div>
      <h4 className="font-medium mb-2">Request Payload</h4>
      <div className="w-full overflow-hidden">
        <pre className="text-xs bg-background p-3 rounded border overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(safeJsonParse(log.requestPayload), null, 2)}
        </pre>
      </div>
    </div>

    {log.responsePayload && (
      <div>
        <h4 className="font-medium mb-2">Response Payload</h4>
        <div className="w-full overflow-hidden">
          <pre className="text-xs bg-background p-3 rounded border overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(safeJsonParse(log.responsePayload), null, 2)}
          </pre>
        </div>
      </div>
    )}

    {log.errorMessage && (
      <div>
        <h4 className="font-medium mb-2 text-destructive">Error Message</h4>
        <div className="w-full overflow-hidden">
          <p className="text-sm text-destructive bg-destructive/10 p-3 rounded border whitespace-pre-wrap break-words">
            {log.errorMessage}
          </p>
        </div>
      </div>
    )}
  </div>
);

export function MetaConversionsManager({
  initialSettings,
}: MetaConversionsManagerProps) {
  // Settings state
  const [settings, setSettings] = useState<MetaConversionsSettings | null>(
    initialSettings || null,
  );
  const [formData, setFormData] = useState<FormData>(DEFAULT_FORM_DATA);
  const [isSettingsLoading, setIsSettingsLoading] = useState(false);
  const [showAccessToken, setShowAccessToken] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Logs state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsPagination, setLogsPagination] = useState<LogsPagination>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [expandedLog, setExpandedLog] = useState<string | null>(null);
  const [retentionInfo, setRetentionInfo] = useState<RetentionInfo | null>(
    null,
  );

  // Dialog states
  const [clearLogsDialog, setClearLogsDialog] = useState(false);
  const [manualCleanupDialog, setManualCleanupDialog] = useState(false);
  const [isManualCleanupLoading, setIsManualCleanupLoading] = useState(false);

  // Initialize form data from settings
  useEffect(() => {
    if (initialSettings) {
      setFormData({
        pixelId: initialSettings.pixelId || "",
        accessToken: initialSettings.accessToken || "",
        testEventCode: initialSettings.testEventCode || "",
        isEnabled: initialSettings.isEnabled || false,
        logRetentionDays: initialSettings.logRetentionDays || 30,
      });
    } else {
      fetchSettings();
    }
  }, [initialSettings]);

  // Load logs when pagination changes
  useEffect(() => {
    fetchLogs();
  }, [logsPagination.page, logsPagination.limit]);

  // Track form changes
  useEffect(() => {
    const currentValues = settings || DEFAULT_FORM_DATA;
    const hasChanges = Object.keys(formData).some(
      (key) =>
        formData[key as keyof FormData] !==
        (currentValues[key as keyof FormData] ||
          DEFAULT_FORM_DATA[key as keyof FormData]),
    );
    setHasUnsavedChanges(hasChanges);
  }, [formData, settings]);

  const fetchSettings = useCallback(async () => {
    setIsSettingsLoading(true);
    try {
      const response = await fetch("/api/admin/settings/meta-conversions");
      if (response.ok) {
        const data = await response.json();
        setSettings(data.data);
        setFormData(
          data.data
            ? {
                pixelId: data.data.pixelId || "",
                accessToken: data.data.accessToken || "",
                testEventCode: data.data.testEventCode || "",
                isEnabled: data.data.isEnabled || false,
                logRetentionDays: data.data.logRetentionDays || 30,
              }
            : DEFAULT_FORM_DATA,
        );
      }
    } catch (error) {
      toast.error("Failed to load settings");
    } finally {
      setIsSettingsLoading(false);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(logsPagination.page),
        limit: String(logsPagination.limit),
      });
      const response = await fetch(
        `/api/admin/settings/meta-conversions/logs?${params}`,
      );
      if (response.ok) {
        const data = await response.json();
        setLogs(data.data || []);
        setLogsPagination((prev: LogsPagination) => data.pagination || prev);
        setRetentionInfo(data.retention || null);
      }
    } catch (error) {
      toast.error("Failed to load logs");
    } finally {
      setLogsLoading(false);
    }
  }, [logsPagination.page, logsPagination.limit]);

  const handleSaveSettings = async () => {
    setIsSettingsLoading(true);
    try {
      const response = await fetch("/api/admin/settings/meta-conversions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to save settings");
      }

      const data = await response.json();
      setSettings(data.data);
      setHasUnsavedChanges(false);
      toast.success("Settings saved successfully");
    } catch (error: any) {
      toast.error(error.message || "Failed to save settings");
    } finally {
      setIsSettingsLoading(false);
    }
  };

  const handleClearLogs = async () => {
    setLogsLoading(true);
    try {
      const response = await fetch(
        "/api/admin/settings/meta-conversions/logs",
        {
          method: "DELETE",
        },
      );

      if (!response.ok) throw new Error("Failed to clear logs");

      setLogs([]);
      setLogsPagination((prev: LogsPagination) => ({
        ...prev,
        total: 0,
        totalPages: 1,
      }));
      toast.success("Logs cleared successfully");
    } catch (error: any) {
      toast.error(error.message || "Failed to clear logs");
    } finally {
      setLogsLoading(false);
      setClearLogsDialog(false);
    }
  };

  const handleManualCleanup = async () => {
    setIsManualCleanupLoading(true);
    try {
      const response = await fetch(
        "/api/admin/settings/meta-conversions/logs",
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to perform manual cleanup");
      }

      const data = await response.json();
      toast.success(data.message || "Manual cleanup completed");
      fetchLogs();
    } catch (error: any) {
      toast.error(error.message || "Failed to perform manual cleanup");
    } finally {
      setIsManualCleanupLoading(false);
      setManualCleanupDialog(false);
    }
  };

  const handleResetForm = () => {
    if (settings) {
      setFormData({
        pixelId: settings.pixelId || "",
        accessToken: settings.accessToken || "",
        testEventCode: settings.testEventCode || "",
        isEnabled: settings.isEnabled || false,
        logRetentionDays: settings.logRetentionDays || 30,
      });
    }
  };

  const handlePageChange = (newPage: number) => {
    setLogsPagination((prev: LogsPagination) => ({ ...prev, page: newPage }));
  };

  const updateFormData = (
    field: keyof FormData,
    value: string | number | boolean,
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="space-y-6">
      <Tabs defaultValue="settings" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="settings" className="flex items-center gap-2">
            <Settings className="w-4 h-4" />
            Settings
          </TabsTrigger>
          <TabsTrigger value="logs" className="flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="w-5 h-5" />
                Meta Conversions API Configuration
              </CardTitle>
              <CardDescription>
                Configure your Meta (Facebook) Conversions API settings to track
                events and conversions. These settings are used to send
                server-side events to Meta for better tracking and attribution.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSaveSettings();
                }}
              >
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label htmlFor="pixelId">Pixel ID</Label>
                      <Input
                        id="pixelId"
                        placeholder="Enter your Meta Pixel ID"
                        value={formData.pixelId}
                        onChange={(e) =>
                          updateFormData("pixelId", e.target.value)
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="testEventCode">
                        Test Event Code (Optional)
                      </Label>
                      <Input
                        id="testEventCode"
                        placeholder="Enter test event code"
                        value={formData.testEventCode}
                        onChange={(e) =>
                          updateFormData("testEventCode", e.target.value)
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="accessToken">Access Token</Label>
                    <div className="relative">
                      <Input
                        id="accessToken"
                        type={showAccessToken ? "text" : "password"}
                        placeholder="Enter your Meta Conversions API access token"
                        value={formData.accessToken}
                        onChange={(e) =>
                          updateFormData("accessToken", e.target.value)
                        }
                        className="pr-10"
                        autoComplete="off"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3 py-2"
                        onClick={() => setShowAccessToken(!showAccessToken)}
                      >
                        {showAccessToken ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      This token is sensitive and will be encrypted when stored.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label htmlFor="logRetentionDays">
                        Log Retention (Days)
                      </Label>
                      <Input
                        id="logRetentionDays"
                        type="number"
                        min="1"
                        max="365"
                        value={formData.logRetentionDays}
                        onChange={(e) =>
                          updateFormData(
                            "logRetentionDays",
                            parseInt(e.target.value) || 30,
                          )
                        }
                      />
                      <p className="text-sm text-muted-foreground">
                        Dashboard setting only. Actual cleanup happens every{" "}
                        {retentionInfo?.hours || 12} hours automatically.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="isEnabled">
                        Enable Meta Conversions API
                      </Label>
                      <div className="flex items-center space-x-2">
                        <Switch
                          id="isEnabled"
                          checked={formData.isEnabled}
                          onCheckedChange={(checked) =>
                            updateFormData("isEnabled", checked)
                          }
                        />
                        <span className="text-sm text-muted-foreground">
                          {formData.isEnabled ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 pt-4">
                    <Button
                      type="submit"
                      disabled={isSettingsLoading || !hasUnsavedChanges}
                      className="flex items-center gap-2"
                    >
                      {isSettingsLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save Settings
                    </Button>
                    {hasUnsavedChanges && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleResetForm}
                        className="flex items-center gap-2"
                      >
                        <RotateCcw className="w-4 h-4" />
                        Reset
                      </Button>
                    )}
                  </div>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="space-y-6">
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchLogs}
                  disabled={logsLoading}
                >
                  {logsLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <RotateCcw className="w-4 h-4" />
                  )}
                  Refresh
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setManualCleanupDialog(true)}
                  disabled={logsLoading}
                >
                  <Brush className="w-4 h-4 mr-2" />
                  Manual Cleanup
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setClearLogsDialog(true)}
                  disabled={logsLoading || logs.length === 0}
                >
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
                            <TableHead className="w-[300px] min-w-[200px]">
                              Event
                            </TableHead>
                            <TableHead className="w-[120px] min-w-[100px]">
                              Status
                            </TableHead>
                            <TableHead className="w-[180px] min-w-[150px]">
                              Event Time
                            </TableHead>
                            <TableHead className="w-[180px] min-w-[150px]">
                              Created
                            </TableHead>
                            <TableHead className="w-[80px] min-w-[60px]">
                              Actions
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {logs.map((log) => (
                            <React.Fragment key={log.id}>
                              <TableRow>
                                <TableCell className="max-w-[300px]">
                                  <div className="space-y-1">
                                    <div className="font-medium truncate">
                                      {log.eventName}
                                    </div>
                                    <div className="text-sm text-muted-foreground truncate">
                                      ID: {log.eventId}
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <StatusBadge status={log.status} />
                                </TableCell>
                                <TableCell className="text-sm">
                                  {formatDate(log.eventTime)}
                                </TableCell>
                                <TableCell className="text-sm">
                                  {formatDate(log.createdAt)}
                                </TableCell>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setExpandedLog(
                                        expandedLog === log.id ? null : log.id,
                                      )
                                    }
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
                                  <TableCell
                                    colSpan={5}
                                    className="border-t-0 p-0"
                                  >
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
        </TabsContent>
      </Tabs>

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

      <AlertDialog
        open={manualCleanupDialog}
        onOpenChange={setManualCleanupDialog}
      >
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
            <AlertDialogAction
              onClick={handleManualCleanup}
              disabled={isManualCleanupLoading}
            >
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
    </div>
  );
}
