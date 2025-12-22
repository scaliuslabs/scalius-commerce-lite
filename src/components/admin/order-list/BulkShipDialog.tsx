import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { useToast } from "@/hooks/use-toast";
import { LoaderCircle, Truck } from "lucide-react";

interface Provider {
  id: string;
  name: string;
  isActive: boolean;
}

interface BulkShipDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  isShipping: boolean;
  onConfirm: (providerId: string) => void;
  itemCount: number;
}

export function BulkShipDialog({
  isOpen,
  onOpenChange,
  isShipping,
  onConfirm,
  itemCount,
}: BulkShipDialogProps) {
  const { toast } = useToast();
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [isLoadingProviders, setIsLoadingProviders] = React.useState(false);
  const [selectedProvider, setSelectedProvider] = React.useState("");

  React.useEffect(() => {
    if (isOpen) {
      const fetchProviders = async () => {
        setIsLoadingProviders(true);
        try {
          const response = await fetch("/api/settings/delivery-providers");
          if (!response.ok) {
            throw new Error("Failed to fetch providers");
          }

          const data = await response.json();
          const activeProviders = data.filter((p: Provider) => p.isActive);
          setProviders(activeProviders);
        } catch (error) {
          console.error("Error fetching providers:", error);
          toast({
            title: "Error",
            description: "Failed to load delivery providers",
            variant: "destructive",
          });
        } finally {
          setIsLoadingProviders(false);
        }
      };

      fetchProviders();
    }
  }, [isOpen, toast]);

  const handleSubmit = () => {
    if (!selectedProvider) {
      toast({
        title: "Error",
        description: "Please select a delivery provider.",
        variant: "destructive",
      });
      return;
    }
    onConfirm(selectedProvider);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px] bg-[var(--card)] border-[var(--border)] rounded-xl shadow-lg border backdrop-blur-lg">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold leading-tight tracking-tight text-[var(--foreground)]">
            Ship Orders
          </DialogTitle>
          <DialogDescription className="text-base text-[var(--muted-foreground)] mt-2">
            Create shipments for the {itemCount} selected orders
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <label
              htmlFor="provider"
              className="text-sm font-medium text-[var(--foreground)]"
            >
              Delivery Provider
            </label>

            <Select
              value={selectedProvider}
              onValueChange={setSelectedProvider}
              disabled={isLoadingProviders || isShipping}
            >
              <SelectTrigger className="h-10 transition-all duration-200 hover:border-[var(--muted)] focus:border-primary focus:ring-2 focus:ring-primary/20 bg-[var(--card)] border-[var(--border)] hover:bg-[var(--muted)]">
                <SelectValue placeholder="Select a delivery provider" />
              </SelectTrigger>
              <SelectContent className="bg-[var(--popover)] border-[var(--border)]">
                {providers.map((provider) => (
                  <SelectItem
                    key={provider.id}
                    value={provider.id}
                    className="transition-colors hover:bg-[var(--muted)]"
                  >
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {isLoadingProviders && (
              <div className="flex items-center justify-center py-2">
                <LoaderCircle className="animate-spin h-5 w-5 text-[var(--muted-foreground)]" />
              </div>
            )}

            {providers.length === 0 && !isLoadingProviders && (
              <p className="mt-1 rounded-md border border-[var(--border)] bg-[var(--muted)] p-2 text-sm text-[var(--muted-foreground)]">
                No active delivery providers found. Please add one in the
                settings.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isShipping}
            className="h-10 transition-all duration-200 bg-[var(--card)] border-[var(--border)] hover:bg-[var(--muted)]"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isShipping || !selectedProvider}
            className="h-10 transition-all duration-200 hover:shadow-md focus:ring-2 focus:ring-primary/40"
          >
            {isShipping ? (
              <>
                <LoaderCircle className="animate-spin -ml-1 mr-2 h-4 w-4" />
                Shipping...
              </>
            ) : (
              <>
                <Truck className="mr-1.5 h-4 w-4" />
                Ship Orders
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}