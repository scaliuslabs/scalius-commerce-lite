import {
  Loader2,
  Truck,
  Download,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { Card, CardContent } from "../../ui/card";
import { Progress } from "../../ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import type { PathaoImportProgress } from "./hooks/useDeliveryLocations";

interface PathaoImportButtonProps {
  hasPathaoProvider: boolean;
  importing: boolean;
  onShowConfirm: () => void;
}

export function PathaoImportButton({
  hasPathaoProvider,
  importing,
  onShowConfirm,
}: PathaoImportButtonProps) {
  if (!hasPathaoProvider) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onShowConfirm}
      disabled={importing}
      className="border-orange-200 text-orange-700 hover:bg-orange-50 hover:text-orange-800 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-950/30 dark:hover:text-orange-300"
    >
      {importing ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <Download className="mr-2 h-4 w-4" />
      )}
      {importing ? "Importing..." : "Import from Pathao"}
    </Button>
  );
}

interface PathaoImportProgressBannerProps {
  importProgress: PathaoImportProgress | null;
  importing: boolean;
  onDismiss: () => void;
  onRetry: () => void;
  onReset: () => void;
}

export function PathaoImportProgressBanner({
  importProgress,
  importing,
  onDismiss,
  onRetry,
  onReset,
}: PathaoImportProgressBannerProps) {
  if (!importProgress || !(importing || importProgress.status === "complete" || importProgress.status === "error")) {
    return null;
  }

  return (
    <Card className="border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-950/20">
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="flex-shrink-0 rounded-lg bg-orange-100 p-2 dark:bg-orange-950/40">
              <Truck className="h-5 w-5 text-orange-600 dark:text-orange-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-sm">
                  {importProgress.status === "complete"
                    ? "Pathao Import Complete"
                    : importProgress.status === "error"
                      ? "Pathao Import Failed"
                      : "Importing from Pathao..."}
                </span>
                {importProgress.status === "importing" && (
                  <Badge variant="outline" className="text-xs bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-800">
                    {importProgress.phase}
                  </Badge>
                )}
                {importProgress.status === "complete" && (
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                )}
                {importProgress.status === "error" && (
                  <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                )}
              </div>

              {importProgress.status === "importing" && (
                <>
                  <p className="text-xs text-muted-foreground mb-2">
                    {importProgress.progress.label}
                  </p>
                  <Progress
                    value={
                      importProgress.progress.total > 0
                        ? (importProgress.progress.current / importProgress.progress.total) * 100
                        : 0
                    }
                    className="h-2 mb-2"
                  />
                  <p className="text-xs text-muted-foreground">
                    {importProgress.progress.current} / {importProgress.progress.total}
                  </p>
                </>
              )}

              {importProgress.status === "error" && importProgress.error && (
                <p className="text-xs text-red-600 dark:text-red-400 mb-2">
                  {importProgress.error}
                </p>
              )}

              {/* Stats row */}
              {(importProgress.stats.citiesCreated > 0 ||
                importProgress.stats.zonesCreated > 0 ||
                importProgress.stats.areasCreated > 0 ||
                importProgress.stats.citiesUpdated > 0 ||
                importProgress.stats.zonesUpdated > 0 ||
                importProgress.stats.areasUpdated > 0) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1">
                  {(importProgress.stats.citiesCreated > 0 || importProgress.stats.citiesUpdated > 0) && (
                    <span>
                      Cities: {importProgress.stats.citiesCreated} created
                      {importProgress.stats.citiesUpdated > 0 && `, ${importProgress.stats.citiesUpdated} updated`}
                    </span>
                  )}
                  {(importProgress.stats.zonesCreated > 0 || importProgress.stats.zonesUpdated > 0) && (
                    <span>
                      Zones: {importProgress.stats.zonesCreated} created
                      {importProgress.stats.zonesUpdated > 0 && `, ${importProgress.stats.zonesUpdated} updated`}
                    </span>
                  )}
                  {(importProgress.stats.areasCreated > 0 || importProgress.stats.areasUpdated > 0) && (
                    <span>
                      Areas: {importProgress.stats.areasCreated} created
                      {importProgress.stats.areasUpdated > 0 && `, ${importProgress.stats.areasUpdated} updated`}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {importProgress.status === "error" && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RotateCcw className="mr-2 h-3.5 w-3.5" />
                Retry
              </Button>
            )}
            {importProgress.status === "complete" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onDismiss}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
            {(importProgress.status === "complete" || importProgress.status === "error") && (
              <Button
                size="sm"
                variant="ghost"
                className="text-xs text-muted-foreground"
                onClick={onReset}
              >
                <RotateCcw className="mr-1.5 h-3 w-3" />
                Reset & Re-import
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

interface PathaoImportConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function PathaoImportConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: PathaoImportConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="rounded-lg bg-orange-100 p-1.5 dark:bg-orange-950/40">
              <Truck className="h-4 w-4 text-orange-600 dark:text-orange-400" />
            </div>
            Import from Pathao
          </DialogTitle>
          <DialogDescription>
            This will import all cities, zones, and areas from Pathao. Existing
            locations with matching Pathao IDs will be updated, not duplicated.
            This may take a few minutes depending on the number of locations.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            className="bg-orange-600 text-white hover:bg-orange-700 dark:bg-orange-700 dark:hover:bg-orange-600"
          >
            <Download className="mr-2 h-4 w-4" />
            Start Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
