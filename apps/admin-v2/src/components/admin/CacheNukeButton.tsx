import { useState } from "react";
import { Eraser } from "lucide-react";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import { clearCache } from "@/lib/api-functions/cache";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";

export function CacheNukeButton() {
  const [clearing, setClearing] = useState(false);

  const handleClearAll = async () => {
    try {
      setClearing(true);
      await clearCache();
      toast.success("All cache cleared successfully");
    } catch (error: unknown) {
      console.error("Error clearing cache:", error);
      toast.error(getServerFnError(error, "Failed to clear cache"));
    } finally {
      setClearing(false);
    }
  };

  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
              disabled={clearing}
            >
              <Eraser className={`w-4 h-4 ${clearing ? "animate-pulse" : ""}`} />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>Clear all cache</p>
        </TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear all cache?</AlertDialogTitle>
          <AlertDialogDescription>
            This will clear all backend API cache and purge the storefront cache.
            The site may be slower for a few moments while caches rebuild.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleClearAll}>
            Clear all cache
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
