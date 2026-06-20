import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getServerFnError } from "~/lib/api-helpers";
import {
  deliveryLocationsQueryOptions,
  deliveryProvidersQueryOptions,
  importPathaoStatusQueryOptions,
} from "~/lib/api-query-options/delivery";
import { queryKeys } from "~/lib/query-keys";
import {
  useCreateDeliveryLocation,
  useUpdateDeliveryLocation,
  useDeleteDeliveryLocation,
  useBulkDeleteDeliveryLocations,
  useCleanAllDeliveryLocations,
} from "~/lib/api-mutations/delivery-locations";
import {
  type DeliveryLocation,
  importPathaoLocations,
  type PathaoImportProgress,
  resetImportPathao,
  type DeliveryLocationsQueryInput,
} from "~/lib/api-functions/delivery";

export type Location = DeliveryLocation;
export type { PathaoImportProgress } from "~/lib/api-functions/delivery";

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

const DEFAULT_PAGINATION: PaginationState = {
  page: 1,
  limit: 20,
  total: 0,
  totalPages: 1,
};

export function useDeliveryLocations() {
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<"city" | "zone" | "area">("city");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedParent, setSelectedParent] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  // Form state
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [formData, setFormData] = useState<LocationFormData>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);

  // Delete state
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deletingLocationId, setDeletingLocationId] = useState<string | null>(
    null,
  );

  // Bulk selection
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([]);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
  const [isCleanAllDialogOpen, setIsCleanAllDialogOpen] = useState(false);

  // Pathao import (kept as local state — this is a streaming/polling operation)
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] =
    useState<PathaoImportProgress | null>(null);
  const importAbortRef = useRef(false);
  const hasResumedImportRef = useRef(false);

  // ── Queries ──────────────────────────────────────────────────────

  // Build location query params
  const locationParams = (() => {
    const params: DeliveryLocationsQueryInput = {
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
    return params;
  })();

  const { data: locationsData, isLoading: loading } = useQuery({
    ...deliveryLocationsQueryOptions(locationParams),
    placeholderData: (prev) => prev,
  });

  const filteredLocations = locationsData?.locations ?? [];
  const pagination = locationsData?.pagination ?? DEFAULT_PAGINATION;

  // Parent locations for zone/area tabs
  const parentType = activeTab === "zone" ? "city" : "zone";
  const parentQueryEnabled = activeTab === "zone" || activeTab === "area";

  const { data: parentData, isLoading: loadingParents } = useQuery({
    ...deliveryLocationsQueryOptions({ type: parentType, limit: 500 }),
    enabled: parentQueryEnabled,
  });

  const parentLocations = parentData?.locations ?? [];

  // Pathao provider check
  const { data: providersData } = useQuery(deliveryProvidersQueryOptions());
  const hasPathaoProvider = (() => {
    const providers = Array.isArray(providersData) ? providersData : [];
    return providers.some((p) => p.type === "pathao" && p.isActive);
  })();

  // Check for existing import on mount
  const { data: importStatusData } = useQuery({
    ...importPathaoStatusQueryOptions(),
    refetchOnMount: true,
    retry: false,
  });

  // ── Mutations ────────────────────────────────────────────────────

  const createMutation = useCreateDeliveryLocation();
  const updateMutation = useUpdateDeliveryLocation();
  const deleteMutation = useDeleteDeliveryLocation();
  const bulkDeleteMutation = useBulkDeleteDeliveryLocations();
  const cleanAllMutation = useCleanAllDeliveryLocations();

  // ── Pathao Import (streaming, not a simple mutation) ─────────────

  const resumeImport = useCallback(async () => {
    importAbortRef.current = false;
    setImporting(true);
    try {
      while (!importAbortRef.current) {
        const data = await importPathaoLocations({
          data: {},
        });
        setImportProgress(data);

        if (data.status === "complete") {
          toast.success(
            `Import complete! Created ${data.stats.citiesCreated} cities, ${data.stats.zonesCreated} zones, ${data.stats.areasCreated} areas.` +
              (data.stats.citiesUpdated +
                data.stats.zonesUpdated +
                data.stats.areasUpdated >
              0
                ? ` Updated ${data.stats.citiesUpdated} cities, ${data.stats.zonesUpdated} zones, ${data.stats.areasUpdated} areas.`
                : ""),
          );
          queryClient.invalidateQueries({
            queryKey: queryKeys.settings.deliveryLocations(),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.settings.deliveryLocationsAll(),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.settings.checkoutReadiness(),
          });
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
  }, [queryClient]);

  useEffect(() => {
    if (
      importStatusData?.status === "importing" &&
      !importing &&
      !hasResumedImportRef.current
    ) {
      hasResumedImportRef.current = true;
      setImportProgress(importStatusData);
      setImporting(true);
      void resumeImport();
    }
  }, [importStatusData, importing, resumeImport]);

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

  // ── Handlers ─────────────────────────────────────────────────────

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
      toast.error(
        `Please select a ${activeTab === "zone" ? "city" : "zone"}`,
      );
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
        await updateMutation.mutateAsync({
          id: editingLocation!.id,
          update: locationData,
        });
      } else {
        await createMutation.mutateAsync(locationData);
      }
      // Toast handled by mutation hook
      closeDialog();
    } catch {
      // Error toast handled by mutation hook
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
      await deleteMutation.mutateAsync({ id: deletingLocationId });
      // Toast handled by mutation hook
      closeDeleteDialog();
    } catch {
      // Error toast handled by mutation hook
      closeDeleteDialog();
    }
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      await updateMutation.mutateAsync({
        id,
        update: { isActive: !currentStatus },
      });
      // Toast handled by mutation hook
    } catch {
      // Error toast handled by mutation hook
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 1 || newPage > pagination.totalPages) return;
    setPage(newPage);
  };

  const handleLimitChange = (newLimit: number) => {
    setLimit(newLimit);
    setPage(1);
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
      await bulkDeleteMutation.mutateAsync({ ids: selectedLocationIds });
      setSelectedLocationIds([]);
      setIsBulkDeleteDialogOpen(false);
    } catch {
      // Error toast handled by mutation hook
      setIsBulkDeleteDialogOpen(false);
    }
  };

  const handleCleanAll = () => {
    setIsCleanAllDialogOpen(true);
  };

  const confirmCleanAll = async () => {
    try {
      await cleanAllMutation.mutateAsync();
      setSelectedLocationIds([]);
      setIsCleanAllDialogOpen(false);
    } catch {
      // Error toast handled by mutation hook
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
