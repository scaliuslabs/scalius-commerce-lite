
import React from 'react';
import { formatDate } from '@scalius/shared/timestamps';
import { createScopedWidgetScript, prepareScopedWidgetContent } from '@scalius/shared/widget-rendering';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { GitCommitHorizontal, Trash2 } from 'lucide-react';
import type { WidgetHistoryEntry } from '@/types/api-responses';

interface WidgetHistoryModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  history: WidgetHistoryEntry[];
  selectedHistoryItem: WidgetHistoryEntry | null;
  setSelectedHistoryItem: (item: WidgetHistoryEntry | null) => void;
  isLoading: boolean;
  error: string | null;
  deletingHistoryIds: Set<string>;
  handleRestore: (historyId: string) => void;
  handleDeleteHistory: (historyId: string) => void;
  widgetName: string;
}

export const WidgetHistoryModal: React.FC<WidgetHistoryModalProps> = ({ 
    isOpen, 
    onOpenChange, 
    history, 
    selectedHistoryItem, 
    setSelectedHistoryItem, 
    isLoading,
    error,
    deletingHistoryIds,
    handleRestore, 
    handleDeleteHistory, 
    widgetName 
}) => {
  const canPreview = !isLoading && !error && selectedHistoryItem;
  const previewContent = selectedHistoryItem
    ? prepareScopedWidgetContent({
        id: selectedHistoryItem.widgetId || selectedHistoryItem.id,
        htmlContent: selectedHistoryItem.htmlContent,
        cssContent: selectedHistoryItem.cssContent,
        jsContent: selectedHistoryItem.jsContent,
      })
    : null;
  const previewScript = selectedHistoryItem ? createScopedWidgetScript(selectedHistoryItem.widgetId || selectedHistoryItem.id, previewContent?.js ?? "") : "";

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-7xl h-[90vh] flex flex-col">
          <DialogHeader>
              <DialogTitle>Version History for "{widgetName}"</DialogTitle>
              <DialogDescription>Preview a saved version, apply its content to the form, then save the widget when ready.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-6 flex-1 overflow-hidden">
              <div className="col-span-1 flex flex-col overflow-y-auto border-r pr-4">
                  {isLoading ? (
                      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                          Loading version history...
                      </div>
                  ) : error ? (
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                          {error}
                      </div>
                  ) : history.length === 0 ? (
                      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                          No saved versions yet.
                      </div>
                  ) : history.map(h => {
                    const isDeleting = deletingHistoryIds.has(h.id);
                    return (
                      <div
                          key={h.id}
                          className={`p-3 rounded-md cursor-pointer group flex justify-between items-center ${selectedHistoryItem?.id === h.id ? 'bg-muted' : 'hover:bg-muted/50'}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedHistoryItem(h)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedHistoryItem(h);
                            }
                          }}
                      >
                          <div>
                              <p className="font-medium flex items-center gap-2"><GitCommitHorizontal className="h-4 w-4 text-muted-foreground" /> {formatDate(h.createdAt)}</p>
                              <p className="text-xs text-muted-foreground ml-6">{h.reason}</p>
                          </div>
                          <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 opacity-0 group-hover:opacity-100 focus:opacity-100"
                              aria-label={`Delete version from ${formatDate(h.createdAt)}`}
                              disabled={isDeleting}
                              onClick={(e) => { e.stopPropagation(); handleDeleteHistory(h.id); }}
                          >
                              <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                      </div>
                    );
                  })}
              </div>
              <div className="col-span-2 flex flex-col overflow-hidden">
                  {canPreview ? (
                      <>
                          <div className="flex-1 overflow-auto border rounded-md">
                              <iframe
                                  srcDoc={`<style>${previewContent?.css ?? ""}</style><div class="widget-container cms-widget-frame ${previewContent?.scopeClass ?? ""}" data-widget-id="${selectedHistoryItem.widgetId}" data-scalius-widget-root="true">${previewContent?.html ?? ""}</div>${previewScript ? `<script>${previewScript}</script>` : ""}`}
                                  className="w-full h-full"
                                  sandbox="allow-scripts"
                                  title="History Preview"
                              />
                          </div>
                          <div className="pt-4 flex justify-end">
                              <Button
                                  type="button"
                                  onClick={() => handleRestore(selectedHistoryItem.id)}
                              >
                                  Apply to Form
                              </Button>
                          </div>
                      </>
                  ) : isLoading ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground">Loading preview...</div>
                  ) : error ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground">Version history unavailable.</div>
                  ) : history.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-muted-foreground">Save a version to preview it here.</div>
                  ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground">Select a version to preview</div>
                  )}
              </div>
          </div>
      </DialogContent>
    </Dialog>
  );
};
