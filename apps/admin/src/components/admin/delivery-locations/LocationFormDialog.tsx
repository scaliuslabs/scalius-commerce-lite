import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import type { Location, LocationFormData } from "./hooks/useDeliveryLocations";

interface LocationFormDialogProps {
  open: boolean;
  onClose: () => void;
  activeTab: "city" | "zone" | "area";
  editMode: boolean;
  formData: LocationFormData;
  setFormData: React.Dispatch<React.SetStateAction<LocationFormData>>;
  isSubmitting: boolean;
  parentLocations: Location[];
  loadingParents: boolean;
  onSubmit: (e: React.SyntheticEvent) => void;
}

export function LocationFormDialog({
  open,
  onClose,
  activeTab,
  editMode,
  formData,
  setFormData,
  isSubmitting,
  parentLocations,
  loadingParents,
  onSubmit,
}: LocationFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editMode ? "Edit" : "Add New"}{" "}
            {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
          </DialogTitle>
          <DialogDescription>
            {editMode ? "Update" : "Create a new"} {activeTab} for delivery
            locations
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit}>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                placeholder={`Enter ${activeTab} name`}
                value={formData.name}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, name: e.target.value }))
                }
                required
              />
            </div>

            {activeTab !== "city" && (
              <div className="space-y-2">
                <Label htmlFor="parentId">
                  {activeTab === "zone" ? "City" : "Zone"}{" "}
                  <span className="text-red-500">*</span>
                </Label>
                <Select
                  value={formData.parentId || "_none"}
                  onValueChange={(value) =>
                    setFormData((prev) => ({
                      ...prev,
                      parentId: value === "_none" ? "" : value,
                    }))
                  }
                  required
                >
                  <SelectTrigger className="bg-background border-border text-foreground">
                    <SelectValue
                      placeholder={`Select ${activeTab === "zone" ? "city" : "zone"}`}
                    />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border text-foreground">
                    {loadingParents ? (
                      <div className="flex items-center justify-center p-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="ml-2">Loading...</span>
                      </div>
                    ) : (
                      <>
                        <SelectItem value="_none" className="text-foreground">
                          -- Select {activeTab === "zone" ? "City" : "Zone"}{" "}
                          --
                        </SelectItem>
                        {parentLocations.map((parent) => (
                          <SelectItem
                            key={parent.id}
                            value={parent.id}
                            className="text-foreground"
                          >
                            {parent.name}
                          </SelectItem>
                        ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center space-x-2">
              <Switch
                id="isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({ ...prev, isActive: checked }))
                }
              />
              <Label htmlFor="isActive">Active</Label>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {editMode ? "Save Changes" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
