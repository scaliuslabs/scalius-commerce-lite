import React from "react";
import {
  Loader2,
  Edit,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "../../ui/button";
import { Badge } from "../../ui/badge";
import { Switch } from "../../ui/switch";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Card, CardContent } from "../../ui/card";
import { Checkbox } from "../../ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import type { Location, PaginationState } from "./hooks/useDeliveryLocations";

interface LocationsTableProps {
  locations: Location[];
  loading: boolean;
  type: "city" | "zone" | "area";
  parentLocations?: Location[];
  onDelete: (id: string) => void;
  onToggleActive: (id: string, currentStatus: boolean) => void;
  pagination: PaginationState;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  onEdit: (location: Location) => void;
  selectedLocationIds: string[];
  onToggleSelectLocation: (locationId: string, isSelected: boolean) => void;
  onSelectAllLocations: (isSelected: boolean) => void;
  areAnySelected: boolean;
  areAllSelected: boolean;
}

const LocationRow = React.memo(function LocationRow({
  location,
  type,
  parentLocations,
  selectedLocationIds,
  onToggleSelectLocation,
  onToggleActive,
  onEdit,
  onDelete,
}: {
  location: Location;
  type: "city" | "zone" | "area";
  parentLocations?: Location[];
  selectedLocationIds: string[];
  onToggleSelectLocation: (locationId: string, isSelected: boolean) => void;
  onToggleActive: (id: string, currentStatus: boolean) => void;
  onEdit: (location: Location) => void;
  onDelete: (id: string) => void;
}) {
  const getParentName = (parentId: string | null) => {
    if (!parentId || !parentLocations) return "N/A";
    const parent = parentLocations.find((p) => p.id === parentId);
    return parent ? parent.name : "Unknown";
  };

  return (
    <TableRow
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
  );
});

export function LocationsTable({
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
              <LocationRow
                key={location.id}
                location={location}
                type={type}
                parentLocations={parentLocations}
                selectedLocationIds={selectedLocationIds}
                onToggleSelectLocation={onToggleSelectLocation}
                onToggleActive={onToggleActive}
                onEdit={onEdit}
                onDelete={onDelete}
              />
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
