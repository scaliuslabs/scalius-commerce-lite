import { useState, useEffect, useCallback, useRef } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  MoreHorizontal,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  Pencil,
  Plus,
  Loader2,
  Languages,
  X,
  Star,
  Globe,
  Archive,
  ArchiveRestore,
  AlertTriangle,
  StarOff,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import type { CheckoutLanguage } from "@/db/schema";

type SortField =
  | "name"
  | "code"
  | "isActive"
  | "isDefault"
  | "createdAt"
  | "updatedAt";
type SortOrder = "asc" | "desc";

interface CheckoutLanguagesManagerProps {
  // Props will be added if we fetch initial data server-side in Astro page later
}

interface ManagerCheckoutLanguage
  extends Omit<CheckoutLanguage, "languageData" | "fieldVisibility"> {
  languageData?: any;
  fieldVisibility?: any;
}

// Default language data structure
const defaultLanguageData = {
  // Page titles and headers
  pageTitle: "Cart & Checkout",
  checkoutSectionTitle: "Checkout Information",
  cartSectionTitle: "Shopping Cart",

  // Form field labels
  customerNameLabel: "Full Name",
  customerNamePlaceholder: "Enter your full name",

  customerPhoneLabel: "Phone Number",
  customerPhonePlaceholder: "01XXXXXXXXX",
  customerPhoneHelp: "Example: 01712345678",

  customerEmailLabel: "Email (Optional)",
  customerEmailPlaceholder: "Enter your email address",

  shippingAddressLabel: "Delivery Address",
  shippingAddressPlaceholder: "Enter your full delivery address",

  cityLabel: "City",
  zoneLabel: "Zone",
  areaLabel: "Area (Optional)",

  shippingMethodLabel: "Choose Delivery Option",

  orderNotesLabel: "Order Notes (Optional)",
  orderNotesPlaceholder: "Any special instructions for your order?",

  // Cart section labels
  continueShoppingText: "Continue Shopping",
  subtotalText: "Subtotal",
  shippingText: "Shipping",
  discountText: "Discount",
  totalText: "Total",

  // Discount section
  discountCodePlaceholder: "Discount code",
  applyDiscountText: "Apply",
  removeDiscountText: "Remove",

  // Buttons and actions
  placeOrderText: "Place Order",
  processingText: "Processing...",

  // Messages and notifications
  emptyCartText: "Your cart is empty",
  termsText:
    "By placing this order, you agree to our Terms of Service and Privacy Policy",

  // Loading overlay
  processingOrderTitle: "Processing Your Order",
  processingOrderMessage: "Please wait while we process your order.",

  // Required field indicators
  requiredFieldIndicator: "*",
};

const defaultFieldVisibility = {
  showEmailField: true,
  showOrderNotesField: true,
  showAreaField: true,
};

export function CheckoutLanguagesManager({}: CheckoutLanguagesManagerProps) {
  const { toast } = useToast();
  const [languages, setLanguages] = useState<ManagerCheckoutLanguage[]>([]);
  const [pagination, setPagination] = useState({
    total: 0,
    page: 1,
    limit: 10,
    totalPages: 1,
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [sort, setSort] = useState<{ field: SortField; order: SortOrder }>({
    field: "name",
    order: "asc",
  });
  const [_, setSelectedLanguages] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [showTrashed, setShowTrashed] = useState(false);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingLanguage, setEditingLanguage] =
    useState<ManagerCheckoutLanguage | null>(null);
  const [currentFormData, setCurrentFormData] = useState<
    Partial<ManagerCheckoutLanguage>
  >({
    name: "",
    code: "",
    isActive: false,
    isDefault: false,
    languageData: { ...defaultLanguageData },
    fieldVisibility: { ...defaultFieldVisibility },
  });

  const [itemToSoftDelete, setItemToSoftDelete] =
    useState<ManagerCheckoutLanguage | null>(null);
  const [itemToPermanentlyDelete, setItemToPermanentlyDelete] =
    useState<ManagerCheckoutLanguage | null>(null);
  const [itemToRestore, setItemToRestore] =
    useState<ManagerCheckoutLanguage | null>(null);

  const initialLoadDone = useRef(false);

  const fetchLanguages = useCallback(
    async (
      pageToFetch = pagination.page,
      limitToFetch = pagination.limit,
      currentSearch = searchQuery,
      currentSort = sort,
      currentShowTrashed = showTrashed,
    ) => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams();
        params.append("page", pageToFetch.toString());
        params.append("limit", limitToFetch.toString());
        if (currentSearch) params.append("search", currentSearch);
        params.append("sort", currentSort.field);
        params.append("order", currentSort.order);
        if (currentShowTrashed) params.append("trashed", "true");

        const response = await fetch(
          `/api/admin/settings/checkout-languages?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch checkout languages");
        const data = await response.json();

        const parsedLanguages = (data.data || []).map((lang: any) => ({
          ...lang,
          languageData:
            typeof lang.languageData === "string"
              ? JSON.parse(lang.languageData)
              : lang.languageData,
          fieldVisibility:
            typeof lang.fieldVisibility === "string"
              ? JSON.parse(lang.fieldVisibility)
              : lang.fieldVisibility,
        }));

        setLanguages(parsedLanguages);
        setPagination(
          data.pagination || {
            total: 0,
            page: 1,
            limit: 10,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        );
      } catch (error) {
        console.error("Error fetching checkout languages:", error);
        toast({
          title: "Error",
          description: "Could not load checkout languages.",
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    },
    [pagination.page, pagination.limit, searchQuery, sort, showTrashed, toast],
  );

  useEffect(() => {
    const url = new URL(window.location.href);
    const pageFromUrl = parseInt(url.searchParams.get("page") || "1");
    const limitFromUrl = parseInt(url.searchParams.get("limit") || "10");
    const searchFromUrl = url.searchParams.get("search") || "";
    const sortFieldFromUrl = url.searchParams.get("sort") as SortField | null;
    const sortOrderFromUrl = url.searchParams.get("order") as SortOrder | null;
    const showTrashedFromUrl = url.searchParams.get("trashed") === "true";

    setSearchQuery(searchFromUrl);
    if (sortFieldFromUrl && sortOrderFromUrl) {
      setSort({ field: sortFieldFromUrl, order: sortOrderFromUrl });
    }
    setShowTrashed(showTrashedFromUrl);

    fetchLanguages(
      pageFromUrl,
      limitFromUrl,
      searchFromUrl,
      sortFieldFromUrl && sortOrderFromUrl
        ? { field: sortFieldFromUrl, order: sortOrderFromUrl }
        : { field: "name", order: "asc" }, // Default sort if not in URL
      showTrashedFromUrl,
    );
    initialLoadDone.current = true;
  }, []);

  useEffect(() => {
    if (initialLoadDone.current) {
      fetchLanguages();
    }
  }, [fetchLanguages]);

  const handleSearch = useCallback(
    (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      const url = new URL(window.location.href);
      if (searchQuery.trim()) {
        url.searchParams.set("search", searchQuery.trim());
      } else {
        url.searchParams.delete("search");
      }
      url.searchParams.set("page", "1");
      window.history.pushState({}, "", url.toString());
      fetchLanguages(1, pagination.limit, searchQuery, sort, showTrashed);
    },
    [searchQuery, pagination.limit, sort, showTrashed, fetchLanguages],
  );

  const handleSort = useCallback(
    (field: SortField) => {
      const newOrder: SortOrder =
        sort.field === field && sort.order === "asc" ? "desc" : "asc";
      const newSort = { field, order: newOrder as SortOrder };
      setSort(newSort);
      const url = new URL(window.location.href);
      url.searchParams.set("sort", field);
      url.searchParams.set("order", newOrder);
      url.searchParams.set("page", "1");
      window.history.pushState({}, "", url.toString());
      fetchLanguages(1, pagination.limit, searchQuery, newSort, showTrashed);
    },
    [sort, pagination.limit, searchQuery, showTrashed, fetchLanguages],
  );

  const toggleTrash = useCallback(() => {
    const newShowTrashed = !showTrashed;
    setShowTrashed(newShowTrashed);
    setSelectedLanguages(new Set()); // Clear selection when switching views
    const url = new URL(window.location.href);
    if (newShowTrashed) {
      url.searchParams.set("trashed", "true");
    } else {
      url.searchParams.delete("trashed");
    }
    url.searchParams.set("page", "1");
    window.history.pushState({}, "", url.toString());
    fetchLanguages(1, pagination.limit, searchQuery, sort, newShowTrashed);
  }, [showTrashed, pagination.limit, searchQuery, sort, fetchLanguages]);

  const openFormForCreate = () => {
    setEditingLanguage(null);
    setCurrentFormData({
      name: "",
      code: "",
      isActive: false,
      isDefault: false,
      languageData: { ...defaultLanguageData },
      fieldVisibility: { ...defaultFieldVisibility },
    });
    setIsFormOpen(true);
  };

  const openFormForEdit = (language: ManagerCheckoutLanguage) => {
    setEditingLanguage(language);
    setCurrentFormData({
      ...language,
      languageData: {
        ...defaultLanguageData,
        ...(language.languageData || {}),
      },
      fieldVisibility: {
        ...defaultFieldVisibility,
        ...(language.fieldVisibility || {}),
      },
    });
    setIsFormOpen(true);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsActionLoading(true);
    const url = editingLanguage
      ? `/api/admin/settings/checkout-languages/${editingLanguage.id}`
      : "/api/admin/settings/checkout-languages";
    const method = editingLanguage ? "PUT" : "POST";

    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentFormData),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error ||
            (editingLanguage ? "Failed to update" : "Failed to create") +
              " checkout language: " +
              (result.details ? JSON.stringify(result.details) : ""),
        );
      }
      toast({
        title: "Success",
        description: `Checkout language ${editingLanguage ? "updated" : "created"} successfully.`,
      });
      setIsFormOpen(false);
      fetchLanguages(
        editingLanguage && !currentFormData.name ? pagination.page : 1,
      ); // Refresh current page or go to first for new/name change
      setSelectedLanguages(new Set());
    } catch (error: any) {
      console.error("Form submission error:", error);
      toast({
        title: "Error",
        description: error.message || "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleSetActive = async (id: string, isActive: boolean) => {
    setIsActionLoading(true);
    try {
      const response = await fetch(
        `/api/admin/settings/checkout-languages/${id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        },
      );
      if (!response.ok) {
        const res = await response.json();
        throw new Error(res.error || "Failed to update active state");
      }
      toast({
        title: "Success",
        description: `Language active state updated successfully.`,
      });
      fetchLanguages(pagination.page);
    } catch (error: any) {
      console.error("Error setting active state:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to update active state.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleSoftDelete = async (language: ManagerCheckoutLanguage | null) => {
    if (!language) return;
    setIsActionLoading(true);
    setItemToSoftDelete(null);
    try {
      const response = await fetch(
        `/api/admin/settings/checkout-languages/${language.id}`,
        {
          method: "PATCH", // Soft delete
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Failed to move to trash");
      }
      toast({
        title: "Success",
        description: `\"${language.name}\" moved to trash.`,
      });
      fetchLanguages(pagination.page);
      setSelectedLanguages((prev) => {
        const next = new Set(prev);
        next.delete(language.id!);
        return next;
      });
    } catch (error: any) {
      console.error("Error soft deleting language:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to move to trash.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handlePermanentDelete = async (
    language: ManagerCheckoutLanguage | null,
  ) => {
    if (!language) return;
    setIsActionLoading(true);
    setItemToPermanentlyDelete(null);
    try {
      const response = await fetch(
        `/api/admin/settings/checkout-languages/${language.id}`,
        {
          method: "DELETE", // Permanent delete
        },
      );
      if (response.status !== 204) {
        // 204 No Content for successful DELETE
        const result = await response.json().catch(() => ({
          error: "Failed to permanently delete after API call.",
        }));
        throw new Error(result.error || "Failed to permanently delete");
      }
      toast({
        title: "Success",
        description: `\"${language.name}\" permanently deleted.`,
      });
      fetchLanguages(pagination.page); // Refresh to reflect deletion
      setSelectedLanguages((prev) => {
        const next = new Set(prev);
        next.delete(language.id!);
        return next;
      });
    } catch (error: any) {
      console.error("Error permanently deleting language:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to permanently delete.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRestore = async (language: ManagerCheckoutLanguage | null) => {
    if (!language) return;
    setIsActionLoading(true);
    setItemToRestore(null);
    try {
      const response = await fetch(
        `/api/admin/settings/checkout-languages/${language.id}/restore`,
        {
          method: "POST",
        },
      );
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || "Failed to restore language");
      }
      toast({
        title: "Success",
        description: `\"${language.name}\" restored successfully.`,
      });
      fetchLanguages(pagination.page); // Refresh to show restored item, likely moving out of trash view
      setSelectedLanguages((prev) => {
        const next = new Set(prev);
        next.delete(language.id!);
        return next;
      });
    } catch (error: any) {
      console.error("Error restoring language:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to restore language.",
        variant: "destructive",
      });
    } finally {
      setIsActionLoading(false);
    }
  };

  const getSortIcon = useCallback(
    (field: SortField) => {
      if (sort.field !== field)
        return <ArrowUpDown className="ml-1 h-3.5 w-3.5 inline" />;
      return sort.order === "asc" ? (
        <ArrowUp className="ml-1 h-3.5 w-3.5 inline" />
      ) : (
        <ArrowDown className="ml-1 h-3.5 w-3.5 inline" />
      );
    },
    [sort],
  );

  const hasActiveFilters = searchQuery.trim().length > 0;
  const clearFilters = useCallback(() => {
    setSearchQuery("");
    const url = new URL(window.location.href);
    url.searchParams.delete("search");
    url.searchParams.set("page", "1");
    window.history.pushState({}, "", url.toString());
    fetchLanguages(1, pagination.limit, "", sort, showTrashed);
  }, [pagination.limit, sort, showTrashed, fetchLanguages]);

  const formatDate = (dateString?: string | number | Date) => {
    if (!dateString) return "N/A";
    try {
      const date = new Date(
        typeof dateString === "number" ? dateString * 1000 : dateString,
      );
      if (isNaN(date.getTime())) return "Invalid Date";
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (e) {
      return "Invalid Date";
    }
  };

  const updateLanguageData = (key: string, value: string) => {
    setCurrentFormData((prev) => ({
      ...prev,
      languageData: {
        ...prev.languageData,
        [key]: value,
      },
    }));
  };

  const updateFieldVisibility = (key: string, value: boolean) => {
    setCurrentFormData((prev) => ({
      ...prev,
      fieldVisibility: {
        ...prev.fieldVisibility,
        [key]: value,
      },
    }));
  };

  return (
    <Card className="border-none shadow-none">
      <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold tracking-tight">
              {showTrashed
                ? "Trashed Checkout Languages"
                : "Checkout Languages"}
            </CardTitle>
            <CardDescription className="mt-0 text-xs text-muted-foreground">
              {showTrashed
                ? "View and manage deleted checkout languages."
                : `Manage checkout form languages and field customization. ${pagination.total} total languages.`}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTrash}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              {showTrashed ? (
                <>
                  <Languages className="h-3.5 w-3.5 mr-1" /> View Active
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> View Trash
                </>
              )}
            </Button>
            {!showTrashed && (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={openFormForCreate}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Language
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="p-2 sm:p-3 space-y-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div className="flex flex-1 items-center w-full sm:w-auto space-x-1.5">
              <form
                onSubmit={handleSearch}
                className="flex-1 sm:flex-initial sm:max-w-xs w-full"
              >
                <div className="relative">
                  <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search languages..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-7 h-7 w-full text-xs"
                  />
                </div>
              </form>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-xs text-muted-foreground"
                  onClick={clearFilters}
                >
                  <X className="h-3.5 w-3.5 mr-1" /> Clear
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("name")}
                  >
                    Name {getSortIcon("name")}
                  </Button>
                </TableHead>
                <TableHead className="py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("code")}
                  >
                    Code {getSortIcon("code")}
                  </Button>
                </TableHead>
                <TableHead className="py-2 text-xs">Status</TableHead>
                <TableHead className="py-2 text-xs">
                  <Button
                    variant="ghost"
                    className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                    onClick={() => handleSort("updatedAt")}
                  >
                    Last Updated {getSortIcon("updatedAt")}
                  </Button>
                </TableHead>
                <TableHead className="w-[70px] text-right pr-3 py-2 text-xs">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && languages.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center">
                    <div className="flex flex-col items-center justify-center gap-1.5">
                      <Languages className="h-8 w-8 text-muted-foreground/50" />
                      <p className="text-base font-medium text-muted-foreground">
                        {hasActiveFilters
                          ? "No languages match criteria."
                          : showTrashed
                            ? "Trash is empty."
                            : "No checkout languages yet."}
                      </p>
                      {!showTrashed && !hasActiveFilters && (
                        <Button
                          size="sm"
                          onClick={openFormForCreate}
                          className="mt-1 h-7 text-xs"
                        >
                          <Plus className="h-3.5 w-3.5 mr-1" />
                          Add First Language
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!isLoading &&
                languages.map((language) => (
                  <TableRow
                    key={language.id}
                    className="hover:bg-muted/50 transition-colors"
                  >
                    <TableCell className="py-2 text-sm font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        {language.isActive && (
                          <Star className="h-3.5 w-3.5 text-yellow-500 fill-current" />
                        )}
                        {language.isDefault && (
                          <Globe className="h-3.5 w-3.5 text-blue-500" />
                        )}
                        {language.name}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-xs font-mono">
                      {language.code}
                    </TableCell>
                    <TableCell className="py-2 text-xs">
                      <div className="flex flex-col gap-1">
                        {language.isActive && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                            Active
                          </span>
                        )}
                        {language.isDefault && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                            Default
                          </span>
                        )}
                        {!language.isActive && !language.isDefault && (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
                            Inactive
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">
                      {formatDate(language.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right pr-3 py-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[180px]">
                          {showTrashed ? (
                            <>
                              <DropdownMenuItem
                                onClick={() => setItemToRestore(language)}
                                disabled={isActionLoading}
                              >
                                <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                                Restore
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() =>
                                  setItemToPermanentlyDelete(language)
                                }
                                className="text-destructive focus:text-destructive focus:bg-destructive/10"
                                disabled={isActionLoading}
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                Delete Permanently
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              <DropdownMenuItem
                                onClick={() => openFormForEdit(language)}
                                disabled={isActionLoading}
                              >
                                <Pencil className="mr-2 h-3.5 w-3.5" />
                                Edit
                              </DropdownMenuItem>
                              {!language.isActive && (
                                <DropdownMenuItem
                                  onClick={() =>
                                    handleSetActive(language.id!, true)
                                  }
                                  disabled={
                                    isActionLoading || language.isActive
                                  }
                                >
                                  <Star className="mr-2 h-3.5 w-3.5" />
                                  Set as Active
                                </DropdownMenuItem>
                              )}
                              {language.isActive && (
                                <DropdownMenuItem
                                  onClick={() =>
                                    handleSetActive(language.id!, false)
                                  }
                                  disabled={
                                    isActionLoading || !language.isActive
                                  }
                                >
                                  <StarOff className="mr-2 h-3.5 w-3.5" />
                                  Deactivate
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => setItemToSoftDelete(language)}
                                className="text-amber-600 focus:text-amber-700 focus:bg-amber-50"
                                disabled={isActionLoading || language.isActive}
                              >
                                <Archive className="mr-2 h-3.5 w-3.5" />
                                Move to Trash
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      {/* Form Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingLanguage ? "Edit" : "Create"} Checkout Language
            </DialogTitle>
            <DialogDescription>
              Configure language settings, field labels, and visibility options.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleFormSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="name" className="text-xs">
                  Language Name
                </Label>
                <Input
                  id="name"
                  value={currentFormData.name || ""}
                  onChange={(e) =>
                    setCurrentFormData((p) => ({ ...p, name: e.target.value }))
                  }
                  required
                  placeholder="e.g., English, বাংলা"
                  className="mt-1 text-sm"
                />
              </div>
              <div>
                <Label htmlFor="code" className="text-xs">
                  Language Code
                </Label>
                <Input
                  id="code"
                  value={currentFormData.code || ""}
                  onChange={(e) =>
                    setCurrentFormData((p) => ({ ...p, code: e.target.value }))
                  }
                  required
                  placeholder="e.g., en, bn"
                  className="mt-1 text-sm"
                />
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <Switch
                  id="isActive"
                  checked={currentFormData.isActive}
                  onCheckedChange={(checked) =>
                    setCurrentFormData((p) => ({ ...p, isActive: checked }))
                  }
                />
                <Label htmlFor="isActive" className="text-xs font-normal">
                  Set as Active Language
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <Switch
                  id="isDefault"
                  checked={currentFormData.isDefault}
                  onCheckedChange={(checked) =>
                    setCurrentFormData((p) => ({ ...p, isDefault: checked }))
                  }
                />
                <Label htmlFor="isDefault" className="text-xs font-normal">
                  Set as Default (Fallback)
                </Label>
              </div>
            </div>

            <Tabs defaultValue="labels" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="labels">Field Labels</TabsTrigger>
                <TabsTrigger value="messages">Messages & Text</TabsTrigger>
                <TabsTrigger value="visibility">Field Visibility</TabsTrigger>
              </TabsList>

              <TabsContent value="labels" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs">Customer Name Label</Label>
                    <Input
                      value={
                        currentFormData.languageData?.customerNameLabel || ""
                      }
                      onChange={(e) =>
                        updateLanguageData("customerNameLabel", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Customer Name Placeholder</Label>
                    <Input
                      value={
                        currentFormData.languageData?.customerNamePlaceholder ||
                        ""
                      }
                      onChange={(e) =>
                        updateLanguageData(
                          "customerNamePlaceholder",
                          e.target.value,
                        )
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Phone Label</Label>
                    <Input
                      value={
                        currentFormData.languageData?.customerPhoneLabel || ""
                      }
                      onChange={(e) =>
                        updateLanguageData("customerPhoneLabel", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Phone Placeholder</Label>
                    <Input
                      value={
                        currentFormData.languageData
                          ?.customerPhonePlaceholder || ""
                      }
                      onChange={(e) =>
                        updateLanguageData(
                          "customerPhonePlaceholder",
                          e.target.value,
                        )
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Email Label</Label>
                    <Input
                      value={
                        currentFormData.languageData?.customerEmailLabel || ""
                      }
                      onChange={(e) =>
                        updateLanguageData("customerEmailLabel", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Email Placeholder</Label>
                    <Input
                      value={
                        currentFormData.languageData
                          ?.customerEmailPlaceholder || ""
                      }
                      onChange={(e) =>
                        updateLanguageData(
                          "customerEmailPlaceholder",
                          e.target.value,
                        )
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Address Label</Label>
                    <Input
                      value={
                        currentFormData.languageData?.shippingAddressLabel || ""
                      }
                      onChange={(e) =>
                        updateLanguageData(
                          "shippingAddressLabel",
                          e.target.value,
                        )
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Address Placeholder</Label>
                    <Input
                      value={
                        currentFormData.languageData
                          ?.shippingAddressPlaceholder || ""
                      }
                      onChange={(e) =>
                        updateLanguageData(
                          "shippingAddressPlaceholder",
                          e.target.value,
                        )
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">City Label</Label>
                    <Input
                      value={currentFormData.languageData?.cityLabel || ""}
                      onChange={(e) =>
                        updateLanguageData("cityLabel", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Zone Label</Label>
                    <Input
                      value={currentFormData.languageData?.zoneLabel || ""}
                      onChange={(e) =>
                        updateLanguageData("zoneLabel", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Area Label</Label>
                    <Input
                      value={currentFormData.languageData?.areaLabel || ""}
                      onChange={(e) =>
                        updateLanguageData("areaLabel", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="messages" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-xs">Page Title</Label>
                    <Input
                      value={currentFormData.languageData?.pageTitle || ""}
                      onChange={(e) =>
                        updateLanguageData("pageTitle", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Checkout Section Title</Label>
                    <Input
                      value={
                        currentFormData.languageData?.checkoutSectionTitle || ""
                      }
                      onChange={(e) =>
                        updateLanguageData(
                          "checkoutSectionTitle",
                          e.target.value,
                        )
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Place Order Button</Label>
                    <Input
                      value={currentFormData.languageData?.placeOrderText || ""}
                      onChange={(e) =>
                        updateLanguageData("placeOrderText", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Processing Text</Label>
                    <Input
                      value={currentFormData.languageData?.processingText || ""}
                      onChange={(e) =>
                        updateLanguageData("processingText", e.target.value)
                      }
                      className="mt-1 text-sm"
                    />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Terms & Conditions Text</Label>
                    <Textarea
                      value={currentFormData.languageData?.termsText || ""}
                      onChange={(e) =>
                        updateLanguageData("termsText", e.target.value)
                      }
                      className="mt-1 text-sm"
                      rows={2}
                    />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="visibility" className="space-y-4 mt-4">
                <div className="space-y-4">
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="showEmailField"
                      checked={
                        currentFormData.fieldVisibility?.showEmailField ?? true
                      }
                      onCheckedChange={(checked) =>
                        updateFieldVisibility("showEmailField", checked)
                      }
                    />
                    <Label
                      htmlFor="showEmailField"
                      className="text-xs font-normal"
                    >
                      Show Email Field
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="showOrderNotesField"
                      checked={
                        currentFormData.fieldVisibility?.showOrderNotesField ??
                        true
                      }
                      onCheckedChange={(checked) =>
                        updateFieldVisibility("showOrderNotesField", checked)
                      }
                    />
                    <Label
                      htmlFor="showOrderNotesField"
                      className="text-xs font-normal"
                    >
                      Show Order Notes Field
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="showAreaField"
                      checked={
                        currentFormData.fieldVisibility?.showAreaField ?? true
                      }
                      onCheckedChange={(checked) =>
                        updateFieldVisibility("showAreaField", checked)
                      }
                    />
                    <Label
                      htmlFor="showAreaField"
                      className="text-xs font-normal"
                    >
                      Show Area Field (Optional)
                    </Label>
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <DialogFooter className="pt-4">
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs h-8"
                >
                  Cancel
                </Button>
              </DialogClose>
              <Button
                type="submit"
                disabled={isActionLoading}
                size="sm"
                className="text-xs h-8"
              >
                {isActionLoading && (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                )}{" "}
                {editingLanguage ? "Save Changes" : "Create Language"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Alert Dialogs */}
      <AlertDialog
        open={!!itemToSoftDelete}
        onOpenChange={(open) => !open && setItemToSoftDelete(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <Archive className="h-4 w-4 text-amber-500" /> Move to Trash?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              Are you sure you want to move "
              {itemToSoftDelete?.name || "this language"}" to trash? It can be
              restored later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
              onClick={() => setItemToSoftDelete(null)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleSoftDelete(itemToSoftDelete)}
              className="h-8 text-xs bg-amber-500 hover:bg-amber-600 text-white"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!itemToPermanentlyDelete}
        onOpenChange={(open) => !open && setItemToPermanentlyDelete(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-red-500" /> Delete
              Permanently?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              Are you sure you want to permanently delete "
              {itemToPermanentlyDelete?.name || "this language"}"? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
              onClick={() => setItemToPermanentlyDelete(null)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handlePermanentDelete(itemToPermanentlyDelete)}
              className="h-8 text-xs bg-red-600 hover:bg-red-700 text-white"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!itemToRestore}
        onOpenChange={(open) => !open && setItemToRestore(null)}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-base">
              <ArchiveRestore className="h-4 w-4 text-green-500" /> Restore
              Language?
            </AlertDialogTitle>
            <AlertDialogDescription className="pt-1 text-xs">
              Are you sure you want to restore "
              {itemToRestore?.name || "this language"}"?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isActionLoading}
              className="h-8 text-xs"
              onClick={() => setItemToRestore(null)}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => handleRestore(itemToRestore)}
              className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
              disabled={isActionLoading}
            >
              {isActionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : null}{" "}
              Restore Language
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
