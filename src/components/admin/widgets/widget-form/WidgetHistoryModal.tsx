
import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { GitCommitHorizontal, Trash2 } from 'lucide-react';

interface WidgetHistoryModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  history: any[];
  selectedHistoryItem: any | null;
  setSelectedHistoryItem: (item: any | null) => void;
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
    handleRestore, 
    handleDeleteHistory, 
    widgetName 
}) => {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-7xl h-[90vh] flex flex-col">
          <DialogHeader>
              <DialogTitle>Version History for "{widgetName}"</DialogTitle>
              <DialogDescription>Review and restore previous versions of this widget.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-3 gap-6 flex-1 overflow-hidden">
              <div className="col-span-1 flex flex-col overflow-y-auto border-r pr-4">
                  {history.map(h => (
                      <div key={h.id} className={`p-3 rounded-md cursor-pointer group flex justify-between items-center ${selectedHistoryItem?.id === h.id ? 'bg-muted' : 'hover:bg-muted/50'}`} onClick={() => setSelectedHistoryItem(h)}>
                          <div>
                              <p className="font-medium flex items-center gap-2"><GitCommitHorizontal className="h-4 w-4 text-muted-foreground" /> {new Date(h.createdAt).toLocaleString()}</p>
                              <p className="text-xs text-muted-foreground ml-6">{h.reason}</p>
                          </div>
                          <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); handleDeleteHistory(h.id); }}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                      </div>
                  ))}
              </div>
              <div className="col-span-2 flex flex-col overflow-hidden">
                  {selectedHistoryItem ? (
                      <>
                          <div className="flex-1 overflow-auto border rounded-md">
                              <iframe
                                  srcDoc={`<style>${selectedHistoryItem.cssContent}</style>${selectedHistoryItem.htmlContent}`}
                                  className="w-full h-full"
                                  sandbox="allow-scripts"
                                  title="History Preview"
                              />
                          </div>
                          <div className="pt-4 flex justify-end">
                              <Button onClick={() => handleRestore(selectedHistoryItem.id)}>Restore This Version</Button>
                          </div>
                      </>
                  ) : (
                      <div className="flex items-center justify-center h-full text-muted-foreground">Select a version to preview</div>
                  )}
              </div>
          </div>
      </DialogContent>
    </Dialog>
  );
};
