import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import type { ShippingMethod } from "./hooks/useShippingMethods";

interface MethodFormDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  editingMethod: ShippingMethod | null;
  isActionLoading: boolean;
  symbol: string;
  onSubmit: (
    formData: Partial<ShippingMethod>,
    editingMethodId: string | null,
  ) => Promise<boolean>;
}

export function MethodFormDialog({
  isOpen,
  onOpenChange,
  editingMethod,
  isActionLoading,
  symbol,
  onSubmit,
}: MethodFormDialogProps) {
  const [currentFormData, setCurrentFormData] = useState<Partial<ShippingMethod>>({
    name: "",
    fee: undefined,
    description: "",
    isActive: true,
    sortOrder: undefined,
  });

  useEffect(() => {
    if (isOpen) {
      if (editingMethod) {
        setCurrentFormData({ ...editingMethod });
      } else {
        setCurrentFormData({
          name: "",
          fee: undefined,
          description: "",
          isActive: true,
          sortOrder: undefined,
        });
      }
    }
  }, [isOpen, editingMethod]);

  const handleFormSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const success = await onSubmit(currentFormData, editingMethod?.id || null);
    if (success) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editingMethod ? "Edit" : "Create"} Shipping Method
          </DialogTitle>
          <DialogDescription>
            Fill in the details for the shipping method.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleFormSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name" className="text-xs">
              Name
            </Label>
            <Input
              id="name"
              value={currentFormData.name || ""}
              onChange={(e) =>
                setCurrentFormData((p) => ({ ...p, name: e.target.value }))
              }
              required
              className="mt-1 text-sm"
            />
          </div>
          <div>
            <Label htmlFor="fee" className="text-xs">
              Fee ({symbol})
            </Label>
            <Input
              id="fee"
              type="number"
              step="0.01"
              value={currentFormData.fee ?? ""}
              onChange={(e) =>
                setCurrentFormData((p) => ({
                  ...p,
                  fee: e.target.value ? parseFloat(e.target.value) : 0,
                }))
              }
              required
              className="mt-1 text-sm"
              placeholder="0.00"
            />
          </div>
          <div>
            <Label htmlFor="description" className="text-xs">
              Description (Optional)
            </Label>
            <Textarea
              id="description"
              value={currentFormData.description || ""}
              onChange={(e) =>
                setCurrentFormData((p) => ({
                  ...p,
                  description: e.target.value,
                }))
              }
              className="mt-1 text-sm"
              rows={2}
            />
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="isActive"
              checked={currentFormData.isActive}
              onCheckedChange={(checked) =>
                setCurrentFormData((p) => ({ ...p, isActive: !!checked }))
              }
            />
            <Label htmlFor="isActive" className="text-xs font-normal">
              Active
            </Label>
          </div>
          <div>
            <Label htmlFor="sortOrder" className="text-xs">
              Sort Order
            </Label>
            <Input
              id="sortOrder"
              type="number"
              value={currentFormData.sortOrder ?? ""}
              onChange={(e) =>
                setCurrentFormData((p) => ({
                  ...p,
                  sortOrder: e.target.value
                    ? parseInt(e.target.value, 10)
                    : 0,
                }))
              }
              className="mt-1 text-sm"
              placeholder="0"
            />
          </div>
          <DialogFooter className="pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm" className="text-xs h-8">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isActionLoading} size="sm" className="text-xs h-8">
              {isActionLoading && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}{" "}
              {editingMethod ? "Save Changes" : "Create Method"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
