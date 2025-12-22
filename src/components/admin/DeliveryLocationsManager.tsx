import React, { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Card, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Loader2,
  Plus,
  Upload,
  Search,
  Edit,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Label } from "../ui/label";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { toast } from "sonner";
import { Checkbox } from "../ui/checkbox";

interface Location {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId: string | null;
  externalIds: Record<string, string | number>;
  metadata: Record<string, any>;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export function DeliveryLocationsManager() {
  const [activeTab, setActiveTab] = useState<"city" | "zone" | "area">("city");
  const [_, setLocations] = useState<Location[]>([]);
  const [filteredLocations, setFilteredLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [parentLocations, setParentLocations] = useState<Location[]>([]);
  const [loadingParents, setLoadingParents] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({
    step: "",
    percent: 0,
  });

  // Pagination state
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });

  // Location form state
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    parentId: "",
    externalIds: {},
    isActive: true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Edit state
  const [editMode, setEditMode] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);

  // State for delete confirmation dialog
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deletingLocationId, setDeletingLocationId] = useState<string | null>(
    null,
  );

  // State for bulk selection
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([]);

  // State for bulk delete confirmation dialog
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);

  // State for clean all confirmation dialog
  const [isCleanAllDialogOpen, setIsCleanAllDialogOpen] = useState(false);

  // Load locations on initial render and when the tab changes
  useEffect(() => {
    loadLocations(1, pagination.limit);
  }, [activeTab, selectedParent, searchQuery]);

  // Load parent locations when needed (for zones and areas)
  useEffect(() => {
    if (activeTab === "zone") {
      loadParentLocations("city");
    } else if (activeTab === "area") {
      loadParentLocations("zone");
    }
  }, [activeTab]);

  const loadLocations = async (
    page = pagination.page,
    limit = pagination.limit,
  ) => {
    try {
      setLoading(true);
      let url = `/api/settings/delivery-locations?type=${activeTab}&page=${page}&limit=${limit}`;

      if (selectedParent && (activeTab === "zone" || activeTab === "area")) {
        url += `&parentId=${selectedParent}`;
      }
      if (searchQuery.trim() !== "") {
        url += `&search=${encodeURIComponent(searchQuery.trim())}`;
      }

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error("Failed to load locations");
      }

      const result = await response.json();
      setLocations(result.data);
      setFilteredLocations(result.data);
      setPagination({
        page: result.pagination.page,
        limit: result.pagination.limit,
        total: result.pagination.total,
        totalPages: result.pagination.totalPages,
      });
    } catch (error) {
      console.error("Error loading locations:", error);
      toast.error("Failed to load locations");
    } finally {
      setLoading(false);
    }
  };

  const loadParentLocations = async (parentType: "city" | "zone") => {
    try {
      setLoadingParents(true);
      const response = await fetch(
        `/api/settings/delivery-locations?type=${parentType}&limit=500`,
      );

      if (!response.ok) {
        throw new Error(`Failed to load ${parentType}s`);
      }

      const result = await response.json();
      setParentLocations(result.data);
    } catch (error) {
      console.error(`Error loading ${parentType}s:`, error);
      toast.error(`Failed to load ${parentType}s`);
    } finally {
      setLoadingParents(false);
    }
  };

  const importFromPathao = async () => {
    try {
      setImporting(true);
      setImportProgress({ step: "Starting import...", percent: 5 });

      // Start the import
      const response = await fetch(
        "/api/settings/delivery-locations/import-pathao",
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error("Failed to import locations from Pathao");
      }

      // Show progress while waiting
      // This is a simulation since we can't get real-time updates from server
      let countdown = 0;
      const interval = setInterval(() => {
        countdown += 1;

        if (countdown <= 10) {
          setImportProgress({
            step: "Fetching cities...",
            percent: 10 + countdown * 3,
          });
        } else if (countdown <= 25) {
          setImportProgress({
            step: "Importing zones...",
            percent: 40 + (countdown - 10) * 2,
          });
        } else {
          setImportProgress({
            step: "Importing areas...",
            percent: 70 + Math.min((countdown - 25) * 1, 25),
          });
        }
      }, 800);

      const result = await response.json();

      // Clear the interval and set to complete
      clearInterval(interval);
      setImportProgress({ step: "Import complete!", percent: 100 });

      if (result.success) {
        toast.success(
          `Successfully imported ${result.counts.total} locations from Pathao`,
        );
        // Small delay to show 100% completion before resetting
        setTimeout(() => {
          setImporting(false);
          setImportProgress({ step: "", percent: 0 });
          loadLocations(1, pagination.limit);
        }, 1000);
      } else {
        toast.info(result.message);
        setImporting(false);
        setImportProgress({ step: "", percent: 0 });
      }
    } catch (error) {
      console.error("Error importing from Pathao:", error);
      toast.error("Failed to import locations from Pathao");
      setImporting(false);
      setImportProgress({ step: "", percent: 0 });
    }
  };

  const handleEditLocation = (location: Location) => {
    setEditingLocation(location);
    setFormData({
      name: location.name,
      parentId: location.parentId || "",
      externalIds: location.externalIds,
      isActive: location.isActive,
    });
    setShowAddDialog(true);
    setEditMode(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validation
    if (!formData.name.trim()) {
      toast.error("Name is required");
      return;
    }

    if (
      activeTab !== "city" &&
      (!formData.parentId || formData.parentId === "_none")
    ) {
      toast.error(`Please select a ${activeTab === "zone" ? "city" : "zone"}`);
      return;
    }

    try {
      setIsSubmitting(true);

      const locationData = {
        name: formData.name,
        type: activeTab,
        parentId: activeTab === "city" ? null : formData.parentId || null,
        externalIds: formData.externalIds,
        metadata: editMode && editingLocation ? editingLocation.metadata : {},
        isActive: formData.isActive,
      };

      const method = editMode ? "PUT" : "POST";
      const url = editMode
        ? `/api/settings/delivery-locations/${editingLocation!.id}`
        : "/api/settings/delivery-locations";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(locationData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            `Failed to ${editMode ? "update" : "create"} location`,
        );
      }

      await response.json();
      toast.success(
        `${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} ${
          editMode ? "updated" : "created"
        } successfully`,
      );

      // Reset form and close dialog
      setFormData({
        name: "",
        parentId: "",
        externalIds: {},
        isActive: true,
      });
      setShowAddDialog(false);
      setEditMode(false);
      setEditingLocation(null);

      // Reload locations
      loadLocations(pagination.page, pagination.limit);
    } catch (error) {
      console.error(
        `Error ${editMode ? "updating" : "creating"} location:`,
        error,
      );
      toast.error(`Failed to ${editMode ? "update" : "create"} ${activeTab}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openDeleteDialog = (id: string) => {
    setDeletingLocationId(id);
    setIsDeleteDialogOpen(true);
  };

  const closeDeleteDialog = () => {
    setIsDeleteDialogOpen(false);
    setDeletingLocationId(null);
  };

  const confirmDelete = async () => {
    if (!deletingLocationId) return;

    try {
      const response = await fetch(
        `/api/settings/delivery-locations/${deletingLocationId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to delete ${activeTab}`);
      }

      toast.success(
        `${
          activeTab.charAt(0).toUpperCase() + activeTab.slice(1)
        } deleted successfully`,
      );
      loadLocations(pagination.page, pagination.limit);
      closeDeleteDialog();
    } catch (error) {
      console.error(`Error deleting ${activeTab}:`, error);
      toast.error(`Failed to delete ${activeTab}`);
      closeDeleteDialog();
    }
  };

  const handleDeleteLocation = (id: string) => {
    openDeleteDialog(id);
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      const response = await fetch(`/api/settings/delivery-locations/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isActive: !currentStatus,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to update ${activeTab} status`);
      }

      toast.success(
        `${
          activeTab.charAt(0).toUpperCase() + activeTab.slice(1)
        } status updated`,
      );
      loadLocations();
    } catch (error) {
      console.error(`Error updating ${activeTab} status:`, error);
      toast.error(`Failed to update ${activeTab} status`);
    }
  };

  // Handle page change
  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > pagination.totalPages) return;
    loadLocations(newPage, pagination.limit);
  };

  // Handle items per page change
  const handleLimitChange = (newLimit: number) => {
    loadLocations(1, newLimit);
  };

  const closeDialog = () => {
    setShowAddDialog(false);
    setEditMode(false);
    setEditingLocation(null);
    setFormData({
      name: "",
      parentId: "",
      externalIds: {},
      isActive: true,
    });
  };

  const handleToggleSelectLocation = (
    locationId: string,
    isSelected: boolean,
  ) => {
    setSelectedLocationIds((prevSelected) =>
      isSelected
        ? [...prevSelected, locationId]
        : prevSelected.filter((id) => id !== locationId),
    );
  };

  const handleSelectAllLocations = (isSelected: boolean) => {
    if (isSelected) {
      setSelectedLocationIds(filteredLocations.map((loc) => loc.id));
    } else {
      setSelectedLocationIds([]);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedLocationIds.length === 0) {
      toast.info("No locations selected for deletion.");
      return;
    }
    // Placeholder for bulk delete API call
    // toast.info(`Would attempt to delete ${selectedLocationIds.length} locations. (Not implemented yet)`);
    // setIsBulkDeleteDialogOpen(true); // Future: open a confirmation dialog
    setIsBulkDeleteDialogOpen(true);
  };

  const confirmBulkDelete = async () => {
    if (selectedLocationIds.length === 0) return;

    try {
      const response = await fetch("/api/settings/delivery-locations", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: selectedLocationIds }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || `Failed to delete selected ${activeTab}s`,
        );
      }

      toast.success(
        `${selectedLocationIds.length} ${activeTab}(s) deleted successfully`,
      );
      setSelectedLocationIds([]);
      loadLocations(pagination.page, pagination.limit); // Reload current page
      setIsBulkDeleteDialogOpen(false);
    } catch (error) {
      console.error(`Error bulk deleting ${activeTab}s:`, error);
      toast.error(`Failed to delete selected ${activeTab}s`);
      setIsBulkDeleteDialogOpen(false);
    }
  };

  const handleCleanAll = () => {
    setIsCleanAllDialogOpen(true);
  };

  const confirmCleanAll = async () => {
    try {
      // This will be a new API endpoint or a modified existing one
      const response = await fetch("/api/settings/delivery-locations/all", {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || "Failed to clean all delivery locations",
        );
      }

      toast.success("All delivery locations have been cleared.");
      setSelectedLocationIds([]); // Clear any selections
      loadLocations(1, pagination.limit); // Reload current page/tab
      setIsCleanAllDialogOpen(false);
    } catch (error) {
      console.error("Error cleaning all delivery locations:", error);
      toast.error("Failed to clean all delivery locations");
      setIsCleanAllDialogOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <Tabs
        defaultValue="city"
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v as "city" | "zone" | "area");
          setSelectedParent(null);
          setSearchQuery("");
        }}
      >
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="city">Cities</TabsTrigger>
            <TabsTrigger value="zone">Zones</TabsTrigger>
            <TabsTrigger value="area">Areas</TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={importFromPathao}
              disabled={importing}
              className="relative"
            >
              {importing ? (
                <>
                  <div
                    className="absolute left-0 top-0 bottom-0 bg-primary/20 z-0 transition-all"
                    style={{ width: `${importProgress.percent}%` }}
                  />
                  <Loader2 className="mr-2 h-4 w-4 animate-spin z-10" />
                  <span className="z-10">{importProgress.step}</span>
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Import from Pathao
                </>
              )}
            </Button>

            <Button variant="outline" size="sm" onClick={handleCleanAll}>
              <Trash2 className="mr-2 h-4 w-4" />
              Clean All Data
            </Button>

            <Button size="sm" onClick={() => setShowAddDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
            </Button>

            {selectedLocationIds.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleBulkDelete}
                disabled={selectedLocationIds.length === 0}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Selected ({selectedLocationIds.length})
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder={`Search ${activeTab}s...`}
              className="pl-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {activeTab !== "city" && (
            <div className="w-64">
              <Select
                value={selectedParent || "_all"}
                onValueChange={(value) =>
                  setSelectedParent(value === "_all" ? null : value)
                }
              >
                <SelectTrigger className="bg-background border-border text-foreground">
                  <SelectValue
                    placeholder={`Filter by ${activeTab === "zone" ? "city" : "zone"}`}
                  />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  <SelectItem value="_all" className="text-foreground">
                    All {activeTab === "zone" ? "Cities" : "Zones"}
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
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <TabsContent value="city" className="mt-6">
          <LocationsTable
            locations={filteredLocations}
            loading={loading}
            type="city"
            parentLocations={parentLocations}
            onDelete={handleDeleteLocation}
            onToggleActive={handleToggleActive}
            pagination={pagination}
            onPageChange={handlePageChange}
            onLimitChange={handleLimitChange}
            onEdit={handleEditLocation}
            selectedLocationIds={selectedLocationIds}
            onToggleSelectLocation={handleToggleSelectLocation}
            onSelectAllLocations={handleSelectAllLocations}
            areAnySelected={selectedLocationIds.length > 0}
            areAllSelected={
              filteredLocations.length > 0 &&
              selectedLocationIds.length === filteredLocations.length
            }
          />
        </TabsContent>

        <TabsContent value="zone" className="mt-6">
          <LocationsTable
            locations={filteredLocations}
            loading={loading}
            type="zone"
            parentLocations={parentLocations}
            onDelete={handleDeleteLocation}
            onToggleActive={handleToggleActive}
            pagination={pagination}
            onPageChange={handlePageChange}
            onLimitChange={handleLimitChange}
            onEdit={handleEditLocation}
            selectedLocationIds={selectedLocationIds}
            onToggleSelectLocation={handleToggleSelectLocation}
            onSelectAllLocations={handleSelectAllLocations}
            areAnySelected={selectedLocationIds.length > 0}
            areAllSelected={
              filteredLocations.length > 0 &&
              selectedLocationIds.length === filteredLocations.length
            }
          />
        </TabsContent>

        <TabsContent value="area" className="mt-6">
          <LocationsTable
            locations={filteredLocations}
            loading={loading}
            type="area"
            parentLocations={parentLocations}
            onDelete={handleDeleteLocation}
            onToggleActive={handleToggleActive}
            pagination={pagination}
            onPageChange={handlePageChange}
            onLimitChange={handleLimitChange}
            onEdit={handleEditLocation}
            selectedLocationIds={selectedLocationIds}
            onToggleSelectLocation={handleToggleSelectLocation}
            onSelectAllLocations={handleSelectAllLocations}
            areAnySelected={selectedLocationIds.length > 0}
            areAllSelected={
              filteredLocations.length > 0 &&
              selectedLocationIds.length === filteredLocations.length
            }
          />
        </TabsContent>
      </Tabs>

      <Dialog open={showAddDialog} onOpenChange={closeDialog}>
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

          <form onSubmit={handleSubmit}>
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
                    setFormData({ ...formData, name: e.target.value })
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
                      setFormData({
                        ...formData,
                        parentId: value === "_none" ? "" : value,
                      })
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
                    setFormData({ ...formData, isActive: checked })
                  }
                />
                <Label htmlFor="isActive">Active</Label>
              </div>
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={closeDialog}>
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

      <Dialog open={isDeleteDialogOpen} onOpenChange={closeDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this {activeTab}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDeleteDialog}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isBulkDeleteDialogOpen}
        onOpenChange={setIsBulkDeleteDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Bulk Delete</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the selected{" "}
              {selectedLocationIds.length} {activeTab}(s)? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsBulkDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmBulkDelete}
            >
              Delete {selectedLocationIds.length} Item(s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isCleanAllDialogOpen}
        onOpenChange={setIsCleanAllDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Confirm Permanent Deletion of All Locations
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to permanently delete ALL cities, zones, and
              areas? This action is irreversible and all delivery location data
              will be lost forever.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsCleanAllDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmCleanAll}
            >
              Yes, Delete All Data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface LocationsTableProps {
  locations: Location[];
  loading: boolean;
  type: "city" | "zone" | "area";
  parentLocations?: Location[];
  onDelete: (id: string) => void;
  onToggleActive: (id: string, currentStatus: boolean) => void;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  onEdit: (location: Location) => void;
  selectedLocationIds: string[];
  onToggleSelectLocation: (locationId: string, isSelected: boolean) => void;
  onSelectAllLocations: (isSelected: boolean) => void;
  areAnySelected: boolean;
  areAllSelected: boolean;
}

function LocationsTable({
  locations,
  loading,
  type,
  parentLocations,
  onDelete,
  onToggleActive,
  pagination,
  onPageChange,
  onLimitChange,
  onEdit,
  selectedLocationIds,
  onToggleSelectLocation,
  onSelectAllLocations,
  areAllSelected,
}: LocationsTableProps) {
  const getParentName = (parentId: string | null) => {
    if (!parentId || !parentLocations) return "N/A";
    const parent = parentLocations.find((p) => p.id === parentId);
    return parent ? parent.name : "Unknown";
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (locations.length === 0) {
    return (
      <Alert className="bg-muted/50">
        <AlertTitle>No {type}s found</AlertTitle>
        <AlertDescription>
          {type === "city"
            ? "Try importing from Pathao or adding cities manually."
            : type === "zone"
              ? "Select a city or add zones manually."
              : "Select a zone or add areas manually."}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">
                <Checkbox
                  checked={areAllSelected}
                  onCheckedChange={(checked) =>
                    onSelectAllLocations(Boolean(checked))
                  }
                  aria-label="Select all rows"
                  disabled={locations.length === 0}
                />
              </TableHead>
              <TableHead>Name</TableHead>
              {type !== "city" && (
                <TableHead>{type === "zone" ? "City" : "Zone"}</TableHead>
              )}
              <TableHead>Status</TableHead>
              <TableHead>External IDs</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.map((location) => (
              <TableRow
                key={location.id}
                data-state={
                  selectedLocationIds.includes(location.id) && "selected"
                }
              >
                <TableCell>
                  <Checkbox
                    checked={selectedLocationIds.includes(location.id)}
                    onCheckedChange={(checked) =>
                      onToggleSelectLocation(location.id, Boolean(checked))
                    }
                    aria-label={`Select row ${location.name}`}
                  />
                </TableCell>
                <TableCell className="font-medium">{location.name}</TableCell>
                {type !== "city" && (
                  <TableCell>{getParentName(location.parentId)}</TableCell>
                )}
                <TableCell>
                  <div className="flex items-center space-x-2">
                    <Switch
                      checked={location.isActive}
                      onCheckedChange={() =>
                        onToggleActive(location.id, location.isActive)
                      }
                    />
                    <Badge
                      variant={location.isActive ? "default" : "secondary"}
                      className={
                        location.isActive
                          ? "bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/30"
                          : "bg-gray-100 text-gray-800 hover:bg-gray-100 dark:bg-gray-800/30 dark:text-gray-300 dark:hover:bg-gray-800/30"
                      }
                    >
                      {location.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(location.externalIds).map(
                      ([provider, id]) => (
                        <Badge
                          key={provider}
                          variant="outline"
                          className="text-xs"
                        >
                          {provider}: {id}
                        </Badge>
                      ),
                    )}
                    {Object.keys(location.externalIds).length === 0 && (
                      <span className="text-muted-foreground text-xs">
                        None
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onEdit(location)}
                      className="h-8 w-8"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="destructive"
                      size="icon"
                      onClick={() => onDelete(location.id)}
                      className="h-8 w-8"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {locations.length > 0 && (
          <div className="flex items-center justify-between px-4 py-4">
            <div className="flex items-center gap-3">
              <div className="text-xs text-gray-500">
                Showing{" "}
                <span className="font-medium">
                  {locations.length === 0
                    ? 0
                    : (pagination.page - 1) * pagination.limit + 1}
                </span>{" "}
                to{" "}
                <span className="font-medium">
                  {Math.min(
                    pagination.page * pagination.limit,
                    pagination.total,
                  )}
                </span>{" "}
                of <span className="font-medium">{pagination.total}</span>{" "}
                {type}s
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 text-xs"
                  >
                    {pagination.limit} per page
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="bg-card border border-border text-foreground"
                >
                  {[10, 20, 50, 100].map((limit) => (
                    <DropdownMenuItem
                      key={limit}
                      onClick={() => onLimitChange(limit)}
                      className={
                        pagination.limit === limit
                          ? "bg-muted text-foreground data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
                          : "text-foreground data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
                      }
                    >
                      {limit} per page
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(pagination.page - 1)}
                disabled={pagination.page <= 1}
                className="h-8 w-8 p-0"
              >
                <ChevronLeft className="h-4 w-4" />
                <span className="sr-only">Previous page</span>
              </Button>

              <div className="flex items-center gap-1 mx-1">
                {Array.from(
                  { length: Math.min(5, pagination.totalPages) },
                  (_, i) => {
                    // Calculate page numbers to show
                    let pageNum;
                    if (pagination.totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (pagination.page <= 3) {
                      pageNum = i + 1;
                    } else if (pagination.page >= pagination.totalPages - 2) {
                      pageNum = pagination.totalPages - 4 + i;
                    } else {
                      pageNum = pagination.page - 2 + i;
                    }

                    return (
                      <Button
                        key={pageNum}
                        variant={
                          pagination.page === pageNum ? "default" : "outline"
                        }
                        size="icon"
                        onClick={() => onPageChange(pageNum)}
                        className="h-8 w-8"
                        aria-label={`Page ${pageNum}`}
                        aria-current={
                          pagination.page === pageNum ? "page" : undefined
                        }
                      >
                        {pageNum}
                      </Button>
                    );
                  },
                )}
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(pagination.page + 1)}
                disabled={pagination.page >= pagination.totalPages}
                className="h-8 w-8 p-0"
              >
                <ChevronRight className="h-4 w-4" />
                <span className="sr-only">Next page</span>
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
