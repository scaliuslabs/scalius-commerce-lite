// src/components/admin/widget-list/WidgetsList.tsx
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useWidgets } from "./hooks/useWidgets";
import { useWidgetActions } from "./hooks/useWidgetActions";
import { useBulkActions } from "./hooks/useBulkActions";
import {
  WidgetStatistics,
  WidgetToolbar,
  WidgetTable,
  WidgetDeleteDialog,
  BulkActionDialog,
} from "./components";
import type {
  WidgetsManagerProps,
  WidgetItem,
  CollectionOption,
  WidgetStatistics as WidgetStats,
  DeleteDialogState,
} from "./types";

interface WidgetsListProps extends WidgetsManagerProps {
  initialWidgets: WidgetItem[];
  initialCollections: CollectionOption[];
  initialStats: WidgetStats;
  initialSearch: string;
}

export function WidgetsList({
  showTrashed = false,
  initialWidgets,
  initialCollections,
  initialStats,
  initialSearch,
}: WidgetsListProps) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState(initialSearch);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(
    null,
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);

  // Custom hooks
  const {
    widgets: allWidgets,
    setWidgets,
    collections,
    stats,
    isLoading,
    fetchWidgets,
  } = useWidgets(initialWidgets, initialCollections, initialStats, showTrashed);

  // Client-side filtering based on search query
  const widgets = searchQuery
    ? allWidgets.filter((widget) =>
        widget.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : allWidgets;

  const {
    savingStates,
    isActionLoading,
    handleUpdate,
    handleDelete,
    handleRestore,
  } = useWidgetActions(fetchWidgets, setWidgets);

  const {
    selectedIds,
    bulkAction,
    isActionLoading: isBulkActionLoading,
    setBulkAction,
    handleBulkAction,
    toggleSelection,
    toggleSelectAll,
  } = useBulkActions(fetchWidgets);

  // Load API key when settings dialog opens
  useEffect(() => {
    if (isSettingsOpen) {
      fetch("/api/settings/openrouter")
        .then((res) => res.json())
        .then((data) => setOpenRouterApiKey(data.apiKey || ""))
        .catch(() => {});
    }
  }, [isSettingsOpen]);

  const handleSaveApiKey = async () => {
    setIsSavingKey(true);
    try {
      const response = await fetch("/api/settings/openrouter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: openRouterApiKey }),
      });
      if (response.ok) {
        toast({ title: "Success", description: "OpenRouter API key saved." });
        setIsSettingsOpen(false);
      } else {
        throw new Error("Failed to save API key.");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Could not save API key.",
        variant: "destructive",
      });
    } finally {
      setIsSavingKey(false);
    }
  };

  const handleDeleteWidget = () => {
    if (!deleteDialog) return;
    handleDelete(deleteDialog.id, deleteDialog.name, showTrashed);
    setDeleteDialog(null);
  };

  const handleCreateClick = () => {
    window.location.href = "/admin/widgets/create";
  };

  const handleCopyShortcode = (widgetId: string) => {
    navigator.clipboard
      .writeText(`[widget id="${widgetId}"]`)
      .then(() => {
        toast({
          title: "Success",
          description: "Shortcode copied to clipboard!",
        });
      })
      .catch(() => {
        toast({
          title: "Error",
          description: "Failed to copy shortcode.",
          variant: "destructive",
        });
      });
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    // No page refresh - filtering happens client-side
  };

  return (
    <div className="space-y-4">
      {/* Statistics Cards */}
      {!showTrashed && (
        <WidgetStatistics
          total={stats.total}
          activeCount={stats.active}
          inactiveCount={stats.inactive}
        />
      )}

      <Card>
        <CardHeader>
          <WidgetToolbar
            searchQuery={searchQuery}
            selectedCount={selectedIds.size}
            showTrashed={showTrashed}
            isActionLoading={isActionLoading || isBulkActionLoading}
            onSearchChange={handleSearchChange}
            onBulkTrash={() => setBulkAction("trash")}
            onBulkDelete={() => setBulkAction("delete")}
            onBulkRestore={() => setBulkAction("restore")}
            onBulkActivate={() => setBulkAction("activate")}
            onBulkDeactivate={() => setBulkAction("deactivate")}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        </CardHeader>
        <CardContent className="p-0">
          <WidgetTable
            widgets={widgets}
            collections={collections}
            selectedIds={selectedIds}
            savingStates={savingStates}
            isActionLoading={isActionLoading}
            isLoading={isLoading}
            showTrashed={showTrashed}
            searchQuery={searchQuery}
            onUpdate={handleUpdate}
            onDelete={(id, name) => setDeleteDialog({ id, name })}
            onRestore={handleRestore}
            onToggleSelection={toggleSelection}
            onToggleSelectAll={() => toggleSelectAll(widgets.map((w) => w.id))}
            onCreateClick={handleCreateClick}
            onCopyShortcode={handleCopyShortcode}
          />
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <WidgetDeleteDialog
        open={!!deleteDialog}
        deleteDialog={deleteDialog}
        showTrashed={showTrashed}
        isActionLoading={isActionLoading}
        onOpenChange={() => setDeleteDialog(null)}
        onConfirm={handleDeleteWidget}
      />

      {/* Bulk Action Confirmation Dialog */}
      <BulkActionDialog
        open={!!bulkAction}
        bulkAction={bulkAction}
        selectedCount={selectedIds.size}
        isActionLoading={isBulkActionLoading}
        onOpenChange={() => setBulkAction(null)}
        onConfirm={() => handleBulkAction(bulkAction)}
      />

      {/* Settings Dialog */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OpenRouter Configuration</DialogTitle>
            <DialogDescription>
              Enter your OpenRouter API key to enable AI widget generation. You
              can get your key from the{" "}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline"
              >
                OpenRouter website
              </a>
              .
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor="apiKey">OpenRouter API Key</Label>
            <Input
              id="apiKey"
              type="password"
              value={openRouterApiKey}
              onChange={(e) => setOpenRouterApiKey(e.target.value)}
              placeholder="sk-or-..."
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsSettingsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveApiKey} disabled={isSavingKey}>
              {isSavingKey ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
