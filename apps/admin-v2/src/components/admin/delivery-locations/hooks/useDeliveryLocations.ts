import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getDeliveryLocations,
  getDeliveryProviders,
  createDeliveryLocation,
  updateDeliveryLocation,
  deleteDeliveryLocation,
  bulkDeleteDeliveryLocations,
  cleanAllDeliveryLocations,
  importPathaoLocations,
  getImportPathaoStatus,
  resetImportPathao,
} from "~/lib/api.functions";

export interface Location {
  id: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId: string | null;
  externalIds: Record<string, string | number>;
  metadata: Record<string, unknown>;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface PathaoImportProgress {
  status: "importing" | "complete" | "error";
  phase: "cities" | "zones" | "areas" | "done";
  progress: { current: number; total: number; label: string };
  stats: {
    citiesCreated: number;
    citiesUpdated: number;
    zonesCreated: number;
    zonesUpdated: number;
    areasCreated: number;
    areasUpdated: number;
  };
  error?: string;
}

export interface PaginationState {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface LocationFormData {
  name: string;
  parentId: string;
  externalIds: Record<string, string | number>;
  isActive: boolean;
}

const INITIAL_FORM: LocationFormData = {
  name: "",
  parentId: "",
  externalIds: {},
  isActive: true,
};

export function useDeliveryLocations() {
  const [activeTab, setActiveTab] = useState<"city" | "zone" | "area">("city");
  const [filteredLocations, setFilteredLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [parentLocations, setParentLocations] = useState<Location[]>([]);
  const [loadingParents, setLoadingParents] = useState(false);

  const [pagination, setPagination] = useState<PaginationState>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });

  // Form state
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [formData, setFormData] = useState<LocationFormData>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);

  // Delete state
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deletingLocationId, setDeletingLocationId] = useState<string | null>(null);

  // Bulk selection
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([]);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
  const [isCleanAllDialogOpen, setIsCleanAllDialogOpen] = useState(false);

  // Pathao import
  const [hasPathaoProvider, setHasPathaoProvider] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<PathaoImportProgress | null>(null);
  const importAbortRef = useRef(false);

  // Check if Pathao provider is configured and active
  useEffect(() => {
    const checkPathaoProvider = async () => {
      try {
        const providers = await getDeliveryProviders() as Array<{ type: string; isActive: boolean }>;
        const hasActive = providers.some(
          (p) => p.type === "pathao" && p.isActive,
        );
        setHasPathaoProvider(hasActive);
      } catch {
        // Silently fail -- button just won't show
      }
    };
    checkPathaoProvider();
  }, []);

  // On mount, check if an import is already in progress
  useEffect(() => {
    const checkExistingImport = async () => {
      try {
        const data = await getImportPathaoStatus() as PathaoImportProgress;
        if (data.status === "importing") {
          setImportProgress(data);
          setImporting(true);
          resumeImport();
        }
      } catch {
        // No in-progress import
      }
    };
    checkExistingImport();
  }, []);

  const loadLocations = async (
    page = pagination.page,
    limit = pagination.limit,
  ) => {
    try {
      setLoading(true);
      const params: Record<string, string | number | boolean | undefined> = {
        type: activeTab,
        page,
        limit,
      };
      if (selectedParent && (activeTab === "zone" || activeTab === "area")) {
        params.parentId = selectedParent;
      }
      if (searchQuery.trim() !== "") {
        params.search = searchQuery.trim();
      }

      const result = await getDeliveryLocations({ data: params }) as {
        locations: Location[];
        pagination: PaginationState;
      };
      setFilteredLocations(result.locations);
      setPagination({
        page: result.pagination.page,
        limit: result.pagination.limit,
        total: result.pagination.total,
        totalPages: result.pagination.totalPages,
      });
    } catch (error: unknown) {
      console.error("Error loading locations:", error);
      toast.error("Failed to load locations");
    } finally {
      setLoading(false);
    }
  };

  const loadParentLocations = async (parentType: "city" | "zone") => {
    try {
      setLoadingParents(true);
      const result = await getDeliveryLocations({
        data: { type: parentType, limit: 500 },
      }) as { locations: Location[] };
      setParentLocations(result.locations);
    } catch (error: unknown) {
      console.error(`Error loading ${parentType}s:`, error);
      toast.error(`Failed to load ${parentType}s`);
    } finally {
      setLoadingParents(false);
    }
  };

  const resumeImport = useCallback(async () => {
    importAbortRef.current = false;
    setImporting(true);
    try {
      while (!importAbortRef.current) {
        const data = await importPathaoLocations({ data: {} }) as PathaoImportProgress;
        setImportProgress(data);

        if (data.status === "complete") {
          toast.success(
            `Import complete! Created ${data.stats.citiesCreated} cities, ${data.stats.zonesCreated} zones, ${data.stats.areasCreated} areas.` +
              (data.stats.citiesUpdated + data.stats.zonesUpdated + data.stats.areasUpdated > 0
                ? ` Updated ${data.stats.citiesUpdated} cities, ${data.stats.zonesUpdated} zones, ${data.stats.areasUpdated} areas.`
                : ""),
          );
          loadLocations(1, pagination.limit);
          break;
        }
        if (data.status === "error") {
          toast.error(data.error || "Import failed");
          break;
        }

        await new Promise((r) => setTimeout(r, 50));
      }
    } catch (err: unknown) {
      const message = getServerFnError(err, "Import failed");
      toast.error(message);
      setImportProgress((prev) =>
        prev ? { ...prev, status: "error", error: message } : null,
      );
    } finally {
      setImporting(false);
    }
  }, []);

  const startImport = () => {
    setShowImportConfirm(false);
    setImportProgress(null);
    resumeImport();
  };

  const resetImport = async () => {
    try {
      await resetImportPathao();
      importAbortRef.current = true;
      setImportProgress(null);
      setImporting(false);
      toast.success("Import progress reset. You can start a fresh import.");
    } catch {
      toast.error("Failed to reset import");
    }
  };

  const retryImport = async () => {
    await resetImport();
    await new Promise((r) => setTimeout(r, 200));
    resumeImport();
  };

  // Load locations when tab/filter changes
  useEffect(() => {
    loadLocations(1, pagination.limit);
  }, [activeTab, selectedParent, searchQuery]);

  // Load parent locations when needed
  useEffect(() => {
    if (activeTab === "zone") {
      loadParentLocations("city");
    } else if (activeTab === "area") {
      loadParentLocations("zone");
    }
  }, [activeTab]);

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

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();

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

      if (editMode) {
        await updateDeliveryLocation({
          data: { id: editingLocation!.id, update: locationData },
        });
      } else {
        await createDeliveryLocation({ data: locationData });
      }
      toast.success(
        `${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} ${editMode ? "updated" : "created"} successfully`,
      );

      closeDialog();
      loadLocations(pagination.page, pagination.limit);
    } catch (error: unknown) {
      console.error(
        `Error ${editMode ? "updating" : "creating"} location:`,
        error,
      );
      toast.error(error instanceof Error ? error.message : `Failed to ${editMode ? "update" : "create"} ${activeTab}`);
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
      await deleteDeliveryLocation({ data: { id: deletingLocationId } });
      toast.success(
        `${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} deleted successfully`,
      );
      loadLocations(pagination.page, pagination.limit);
      closeDeleteDialog();
    } catch (error: unknown) {
      console.error(`Error deleting ${activeTab}:`, error);
      toast.error(getServerFnError(error, `Failed to delete ${activeTab}`));
      closeDeleteDialog();
    }
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      await updateDeliveryLocation({
        data: { id, update: { isActive: !currentStatus } },
      });
      toast.success(
        `${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} status updated`,
      );
      loadLocations();
    } catch (error: unknown) {
      console.error(`Error updating ${activeTab} status:`, error);
      toast.error(getServerFnError(error, `Failed to update ${activeTab} status`));
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > pagination.totalPages) return;
    loadLocations(newPage, pagination.limit);
  };

  const handleLimitChange = (newLimit: number) => {
    loadLocations(1, newLimit);
  };

  const closeDialog = () => {
    setShowAddDialog(false);
    setEditMode(false);
    setEditingLocation(null);
    setFormData(INITIAL_FORM);
  };

  const handleToggleSelectLocation = (
    locationId: string,
    isSelected: boolean,
  ) => {
    setSelectedLocationIds((prev) =>
      isSelected
        ? [...prev, locationId]
        : prev.filter((id) => id !== locationId),
    );
  };

  const handleSelectAllLocations = (isSelected: boolean) => {
    setSelectedLocationIds(
      isSelected ? filteredLocations.map((loc) => loc.id) : [],
    );
  };

  const handleBulkDelete = () => {
    if (selectedLocationIds.length === 0) {
      toast.info("No locations selected for deletion.");
      return;
    }
    setIsBulkDeleteDialogOpen(true);
  };

  const confirmBulkDelete = async () => {
    if (selectedLocationIds.length === 0) return;

    try {
      await bulkDeleteDeliveryLocations({ data: { ids: selectedLocationIds } });
      toast.success(
        `${selectedLocationIds.length} ${activeTab}(s) deleted successfully`,
      );
      setSelectedLocationIds([]);
      loadLocations(pagination.page, pagination.limit);
      setIsBulkDeleteDialogOpen(false);
    } catch (error: unknown) {
      console.error(`Error bulk deleting ${activeTab}s:`, error);
      toast.error(getServerFnError(error, `Failed to delete selected ${activeTab}s`));
      setIsBulkDeleteDialogOpen(false);
    }
  };

  const handleCleanAll = () => {
    setIsCleanAllDialogOpen(true);
  };

  const confirmCleanAll = async () => {
    try {
      await cleanAllDeliveryLocations();
      toast.success("All delivery locations have been cleared.");
      setSelectedLocationIds([]);
      loadLocations(1, pagination.limit);
      setIsCleanAllDialogOpen(false);
    } catch (error: unknown) {
      console.error("Error cleaning all delivery locations:", error);
      toast.error(getServerFnError(error, "Failed to clean all delivery locations"));
      setIsCleanAllDialogOpen(false);
    }
  };

  return {
    // Tab state
    activeTab,
    setActiveTab,
    // Locations data
    filteredLocations,
    loading,
    searchQuery,
    setSearchQuery,
    selectedParent,
    setSelectedParent,
    parentLocations,
    loadingParents,
    pagination,
    // Form state
    showAddDialog,
    setShowAddDialog,
    formData,
    setFormData,
    isSubmitting,
    editMode,
    editingLocation,
    // CRUD
    handleEditLocation,
    handleSubmit,
    handleToggleActive,
    closeDialog,
    // Delete
    isDeleteDialogOpen,
    deletingLocationId,
    openDeleteDialog,
    closeDeleteDialog,
    confirmDelete,
    // Bulk
    selectedLocationIds,
    handleToggleSelectLocation,
    handleSelectAllLocations,
    handleBulkDelete,
    isBulkDeleteDialogOpen,
    setIsBulkDeleteDialogOpen,
    confirmBulkDelete,
    // Clean all
    isCleanAllDialogOpen,
    setIsCleanAllDialogOpen,
    handleCleanAll,
    confirmCleanAll,
    // Pathao import
    hasPathaoProvider,
    showImportConfirm,
    setShowImportConfirm,
    importing,
    importProgress,
    setImportProgress,
    startImport,
    resetImport,
    retryImport,
    // Pagination
    handlePageChange,
    handleLimitChange,
  };
}
