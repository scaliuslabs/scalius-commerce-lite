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

  const handleInvalidateCaches = async () => {
    try {
      setClearing(true);
      await clearCache();
      toast.success(
        "API cache invalidated and storefront edge cache purge requested",
      );
    } catch (error: unknown) {
      console.error("Error invalidating cache:", error);
      toast.error(
        getServerFnError(
          error,
          "Failed to invalidate API cache and purge storefront edge cache",
        ),
      );
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
              aria-label="Invalidate API cache and purge storefront edge cache"
            >
              <Eraser
                className={`w-4 h-4 ${clearing ? "animate-pulse" : ""}`}
              />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>Invalidate API cache and purge storefront edge cache</p>
        </TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Invalidate API cache and purge storefront edge cache?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This will invalidate backend API cache and request a storefront edge
            cache purge.
            The site may be slower for a few moments while caches rebuild.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleInvalidateCaches}>
            Invalidate and purge
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
