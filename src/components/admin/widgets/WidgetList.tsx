import React, { useState, useEffect } from "react";
import type { Collection, Widget as DbWidget, WidgetPlacementRule } from "@/db/schema";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Trash2,
  Edit,
  Undo,
  XCircle,
  AlertTriangle,
  Copy,
  PlusCircle,
  Search,
  ArrowUpDown,
  LayoutDashboard,
  Activity,
  Archive,
  KeyRound,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface WidgetDisplayItem extends Omit<DbWidget, "createdAt" | "updatedAt" | "deletedAt" | "htmlContent" | "cssContent" | "displayTarget"> {
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt?: string | null;
}

type SortField = "name" | "placementRule" | "sortOrder" | "updatedAt";

interface WidgetListProps {
  widgets: WidgetDisplayItem[];
  collections: Pick<Collection, "id" | "name" | "type" | "sortOrder">[];
  showTrashed?: boolean;
  stats: { total: number; active: number; inactive: number };
  initialFilters: { search: string; status: string; placement: string };
  initialSort: { field: SortField; order: "asc" | "desc" };
}

const placementRuleLabels: Record<string, string> = {
  before_collection: "Before Collection",
  after_collection: "After Collection",
  fixed_top_homepage: "Fixed: Top of Homepage",
  fixed_bottom_homepage: "Fixed: Bottom of Homepage",
  standalone: "Standalone (Shortcode)",
};

export const WidgetList: React.FC<WidgetListProps> = ({
  widgets: initialWidgets,
  collections,
  showTrashed = false,
  stats,
  initialFilters
}) => {
  const { toast } = useToast();
  const [currentWidgets, setCurrentWidgets] = useState<WidgetDisplayItem[]>(initialWidgets);
  const [widgetToConfirmDelete, setWidgetToConfirmDelete] = useState<WidgetDisplayItem | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingWidgets, setProcessingWidgets] = useState<Set<string>>(new Set());

  const [searchQuery, setSearchQuery] = useState(initialFilters.search);
  const [statusFilter, setStatusFilter] = useState(initialFilters.status);
  const [placementFilter, setPlacementFilter] = useState(initialFilters.placement);
  
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [isSavingKey, setIsSavingKey] = useState(false);

  useEffect(() => {
    if (isSettingsOpen) {
      fetch("/api/settings/openrouter")
        .then(res => res.json())
        .then(data => setOpenRouterApiKey(data.apiKey || ""));
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
      toast({ title: "Error", description: "Could not save API key.", variant: "destructive" });
    } finally {
      setIsSavingKey(false);
    }
  };

  const getCollectionName = (collectionId: string | null) => {
    if (!collectionId) return "N/A";
    const collection = collections.find((c) => c.id === collectionId);
    return collection ? collection.name : "Unknown Collection";
  };

  const formatPlacement = (widget: WidgetDisplayItem) => {
    const rule = widget.placementRule as WidgetPlacementRule;
    if (rule === "before_collection" || rule === "after_collection") {
      return `${placementRuleLabels[rule]}: ${getCollectionName(widget.referenceCollectionId)}`;
    }
    return placementRuleLabels[rule] || "Unknown Placement";
  };

  const handleToggleStatus = async (widgetId: string, currentStatus: boolean) => {
    setProcessingWidgets(prev => new Set(prev).add(widgetId));
    try {
      const response = await fetch(`/api/widgets/${widgetId}/toggle-status`, { method: 'PATCH' });
      if (!response.ok) throw new Error("Failed to toggle status.");
      
      const updatedWidget = await response.json();
      setCurrentWidgets(prev => prev.map(w => w.id === widgetId ? { ...w, isActive: updatedWidget.isActive, updatedAt: updatedWidget.updatedAt } : w));
      toast({ title: "Success", description: `Widget status updated to ${updatedWidget.isActive ? 'Active' : 'Inactive'}.` });
    } catch (error) {
        toast({ title: "Error", description: `Failed to update status.`, variant: "destructive" });
        setCurrentWidgets(prev => prev.map(w => w.id === widgetId ? { ...w, isActive: currentStatus } : w));
    } finally {
        setProcessingWidgets(prev => {
            const newSet = new Set(prev);
            newSet.delete(widgetId);
            return newSet;
        });
    }
  };
  
  const handleAction = async (action: 'softDelete' | 'restore' | 'permanentDelete', widgetId: string) => {
    setIsProcessing(true);
    let url = `/api/widgets/${widgetId}`;
    let method = 'DELETE';
    let successMessage = "Widget moved to trash.";

    if (action === 'restore') {
      url = `/api/widgets/${widgetId}/restore`;
      method = 'POST';
      successMessage = "Widget restored successfully.";
    } else if (action === 'permanentDelete') {
      url = `/api/widgets/${widgetId}/permanent`;
      method = 'DELETE';
      successMessage = "Widget permanently deleted.";
    }

    try {
      const response = await fetch(url, { method });
      if (response.ok) {
        setCurrentWidgets(prev => prev.filter(w => w.id !== widgetId));
        toast({ title: "Success", description: successMessage });
      } else {
        const errorData = await response.json().catch(() => ({ message: `Failed to ${action}.` }));
        toast({ title: "Error", description: errorData.message, variant: "destructive" });
      }
    } catch (error) {
      toast({ title: "Error", description: `An unexpected error occurred.`, variant: "destructive" });
    } finally {
      setIsProcessing(false);
      setWidgetToConfirmDelete(null);
    }
  };

  const onConfirmDelete = () => {
    if (!widgetToConfirmDelete) return;
    const action = showTrashed ? 'permanentDelete' : 'softDelete';
    handleAction(action, widgetToConfirmDelete.id);
  };

  const copyWidgetShortcode = (widgetId: string) => {
    navigator.clipboard.writeText(`[widget id="${widgetId}"]`).then(() => {
        toast({ title: "Success", description: "Shortcode copied to clipboard!" });
    }).catch(() => {
        toast({ title: "Error", description: "Failed to copy shortcode.", variant: "destructive" });
    });
  };

  const handleApplyFilters = () => {
    const params = new URLSearchParams(window.location.search);
    searchQuery ? params.set("search", searchQuery) : params.delete("search");
    statusFilter ? params.set("status", statusFilter) : params.delete("status");
    placementFilter ? params.set("placement", placementFilter) : params.delete("placement");
    
    // Preserve existing sort order when applying filters
    const currentUrlParams = new URLSearchParams(window.location.search);
    if (currentUrlParams.has('sort')) {
      params.set('sort', currentUrlParams.get('sort')!);
    }
    if (currentUrlParams.has('order')) {
      params.set('order', currentUrlParams.get('order')!);
    }

    window.location.search = params.toString();
  };

  const handleResetFilters = () => {
    window.location.search = showTrashed ? "trashed=true" : "";
  };
  
  const handleSort = (field: SortField) => {
    const params = new URLSearchParams(window.location.search);
    const currentOrder = params.get('order');
    const newOrder = params.get('sort') === field && currentOrder === 'desc' ? 'asc' : 'desc';
    params.set('sort', field);
    params.set('order', newOrder);
    window.location.search = params.toString();
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>{showTrashed ? "Widget Trash" : "All Widgets"}</CardTitle>
            <CardDescription>View, manage, and organize all your content widgets.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {!showTrashed && <Button asChild><a href="/admin/widgets/create"><PlusCircle className="mr-2 h-4 w-4" /> Create New</a></Button>}
            <Button variant="outline" size="icon" onClick={() => setIsSettingsOpen(true)}>
              <KeyRound className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        {!showTrashed && (
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="flex items-center space-x-4 rounded-md border p-4"><LayoutDashboard className="h-8 w-8 text-muted-foreground" /><div className="flex-1 space-y-1"><p className="text-sm font-medium leading-none">Total Widgets</p><p className="text-2xl font-semibold">{stats.total}</p></div></div>
            <div className="flex items-center space-x-4 rounded-md border p-4"><Activity className="h-8 w-8 text-green-500" /><div className="flex-1 space-y-1"><p className="text-sm font-medium leading-none">Active</p><p className="text-2xl font-semibold">{stats.active}</p></div></div>
            <div className="flex items-center space-x-4 rounded-md border p-4"><Archive className="h-8 w-8 text-red-500" /><div className="flex-1 space-y-1"><p className="text-sm font-medium leading-none">Inactive</p><p className="text-2xl font-semibold">{stats.inactive}</p></div></div>
          </CardContent>
        )}
      </Card>
      
      <Card>
        <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row gap-4">
                <div className="relative flex-grow">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input placeholder="Search by name..." className="pl-10" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleApplyFilters()} />
                </div>
                <Select value={statusFilter || 'all'} onValueChange={value => setStatusFilter(value === 'all' ? '' : value)}>
                    <SelectTrigger className="w-full md:w-[180px]"><SelectValue placeholder="Filter by status" /></SelectTrigger>
                    <SelectContent className="rounded-xl bg-background"><SelectItem value="all">All Statuses</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Inactive</SelectItem></SelectContent>
                </Select>
                <Select value={placementFilter || 'all'} onValueChange={value => setPlacementFilter(value === 'all' ? '' : value)}>
                    <SelectTrigger className="w-full md:w-[240px]"><SelectValue placeholder="Filter by placement" /></SelectTrigger>
                    <SelectContent className="rounded-xl bg-background"><SelectItem value="all">All Placements</SelectItem>{Object.entries(placementRuleLabels).map(([key, label]) => (<SelectItem key={key} value={key}>{label}</SelectItem>))}</SelectContent>
                </Select>
                <Button onClick={handleApplyFilters} className="w-full md:w-auto">Apply</Button>
                <Button variant="ghost" onClick={handleResetFilters} className="w-full md:w-auto">Reset</Button>
            </div>
        </CardContent>
      </Card>

      <div className="border rounded-lg shadow-sm bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead><Button variant="ghost" onClick={() => handleSort('name')}>Name <ArrowUpDown className="ml-2 h-4 w-4 inline opacity-50" /></Button></TableHead>
              <TableHead><Button variant="ghost" onClick={() => handleSort('placementRule')}>Placement <ArrowUpDown className="ml-2 h-4 w-4 inline opacity-50" /></Button></TableHead>
              <TableHead className="w-[120px] text-center">Status</TableHead>
              <TableHead className="w-[100px] text-center"><Button variant="ghost" onClick={() => handleSort('sortOrder')}>Order <ArrowUpDown className="ml-2 h-4 w-4 inline opacity-50" /></Button></TableHead>
              <TableHead className="w-[180px] text-center"><Button variant="ghost" onClick={() => handleSort('updatedAt')}>Last Updated <ArrowUpDown className="ml-2 h-4 w-4 inline opacity-50" /></Button></TableHead>
              <TableHead className="w-[150px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {currentWidgets.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-12"><div className="flex flex-col items-center gap-2"><AlertTriangle className="w-10 h-10 text-muted-foreground/50" /><p className="font-medium">{showTrashed ? "The trash is empty." : "No widgets found matching your criteria."}</p>{!showTrashed && <p className="text-sm text-muted-foreground">Try adjusting your filters or <a href="/admin/widgets/create" className="text-primary hover:underline">create a new widget</a>.</p>}</div></TableCell></TableRow>
            ) : (
              currentWidgets.map((widget) => (
                <TableRow key={widget.id}>
                  <TableCell className="font-medium">{widget.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatPlacement(widget)}</TableCell>
                  <TableCell className="text-center">
                    {showTrashed ? <Badge variant="destructive">Trashed</Badge> : <Switch checked={widget.isActive} onCheckedChange={() => handleToggleStatus(widget.id, widget.isActive)} disabled={processingWidgets.has(widget.id)} aria-label="Toggle widget status" />}
                  </TableCell>
                  <TableCell className="text-center">{widget.sortOrder}</TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">{hydrated && widget.updatedAt ? new Date(widget.updatedAt).toLocaleString() : '...'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {showTrashed ? (
                        <>
                          <Button variant="outline" size="sm" onClick={() => handleAction('restore', widget.id)} disabled={isProcessing}><Undo className="mr-1.5 h-3.5 w-3.5" />Restore</Button>
                          <Button variant="ghost" size="icon" onClick={() => setWidgetToConfirmDelete(widget)} disabled={isProcessing} title="Delete Permanently" className="text-destructive hover:bg-destructive/10"><XCircle className="h-4 w-4" /></Button>
                        </>
                      ) : (
                        <>
                          <Button variant="ghost" size="icon" asChild className="hover:bg-muted" title="Edit Widget"><a href={`/admin/widgets/${widget.id}`}><Edit className="h-4 w-4" /></a></Button>
                          <Button variant="ghost" size="icon" onClick={() => setWidgetToConfirmDelete(widget)} disabled={isProcessing} title="Move to Trash" className="text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></Button>
                          <Button variant="outline" size="sm" className="h-8 px-2" onClick={() => copyWidgetShortcode(widget.id)}><Copy className="mr-1 h-3 w-3" /> Shortcode</Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!widgetToConfirmDelete} onOpenChange={() => setWidgetToConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{showTrashed ? "Delete Widget Permanently?" : "Move Widget to Trash?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {showTrashed ? "This action cannot be undone. The widget will be permanently removed." : "This widget will be moved to the trash. You can restore it later."}<br/>
              Widget: <strong>{widgetToConfirmDelete?.name}</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDelete} disabled={isProcessing} className={showTrashed ? "bg-destructive hover:bg-destructive/90" : ""}>
              {isProcessing ? "Processing..." : (showTrashed ? "Delete Permanently" : "Move to Trash")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>OpenRouter Configuration</DialogTitle>
            <DialogDescription>
              Enter your OpenRouter API key to enable AI widget generation. You can get your key from the{" "}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary underline">
                OpenRouter website
              </a>.
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
            <Button variant="ghost" onClick={() => setIsSettingsOpen(false)}>Cancel</Button>
            <Button onClick={handleSaveApiKey} disabled={isSavingKey}>
              {isSavingKey ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
};