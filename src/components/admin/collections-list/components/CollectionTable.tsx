// src/components/admin/collections-list/components/CollectionTable.tsx
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowUpDown, Layers, Plus } from "lucide-react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { cn } from "@/lib/utils";
import { CollectionRow } from "./CollectionRow";
import type { CollectionTableProps } from "../types";

export function CollectionTable({
  collections,
  selectedIds,
  savingStates,
  isActionLoading,
  isLoading,
  showTrashed,
  searchQuery,
  sortField,
  onSort,
  onUpdate,
  onDelete,
  onRestore,
  onToggleSelection,
  onToggleSelectAll,
  onCreateClick,
  onDragEnd,
  onDragStart,
}: CollectionTableProps) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <DragDropContext onDragEnd={onDragEnd} onDragStart={onDragStart}>
        <Table>
          <TableHeader>
            <TableRow>
              {!showTrashed && <TableHead className="w-10"></TableHead>}
              <TableHead className="w-10">
                <Checkbox
                  onCheckedChange={onToggleSelectAll}
                  checked={
                    selectedIds.size > 0 &&
                    selectedIds.size === collections.length
                  }
                />
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 h-8"
                  onClick={() => onSort("name")}
                >
                  Collection Name
                  <ArrowUpDown
                    className={cn(
                      "ml-2 h-4 w-4",
                      sortField === "name"
                        ? "text-primary"
                        : "text-muted-foreground",
                    )}
                  />
                </Button>
              </TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 h-8"
                  onClick={() => onSort("type")}
                >
                  Type
                  <ArrowUpDown
                    className={cn(
                      "ml-2 h-4 w-4",
                      sortField === "type"
                        ? "text-primary"
                        : "text-muted-foreground",
                    )}
                  />
                </Button>
              </TableHead>
              <TableHead>Content Source</TableHead>
              <TableHead>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 h-8"
                  onClick={() => onSort("isActive")}
                >
                  Status
                  <ArrowUpDown
                    className={cn(
                      "ml-2 h-4 w-4",
                      sortField === "isActive"
                        ? "text-primary"
                        : "text-muted-foreground",
                    )}
                  />
                </Button>
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          {showTrashed ? (
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {collections.map((collection) => (
                    <CollectionRow
                      key={collection.id}
                      collection={collection}
                      onUpdate={onUpdate}
                      onDelete={() => onDelete(collection.id, collection.name)}
                      onRestore={() => onRestore(collection.id)}
                      onPermanentDelete={() =>
                        onDelete(collection.id, collection.name)
                      }
                      onToggleSelection={() => onToggleSelection(collection.id)}
                      isSelected={selectedIds.has(collection.id)}
                      isSaving={savingStates[collection.id]}
                      isActionLoading={isActionLoading}
                      showTrashed={showTrashed}
                    />
                  ))}
                </>
              )}
              {!isLoading && collections.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-48 text-center text-muted-foreground"
                  >
                    <div className="flex flex-col items-center justify-center gap-3">
                      <Layers className="h-12 w-12 opacity-40" />
                      <div className="space-y-1">
                        <p className="font-medium text-lg">
                          {searchQuery
                            ? "No collections found"
                            : "Trash is empty"}
                        </p>
                        <p className="text-sm">
                          {searchQuery
                            ? "Try adjusting your search query."
                            : "Deleted collections will appear here."}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          ) : (
            <Droppable droppableId="collections">
              {(provided) => (
                <TableBody {...provided.droppableProps} ref={provided.innerRef}>
                  {isLoading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center">
                        <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
                      </TableCell>
                    </TableRow>
                  ) : (
                    <>
                      {collections.map((collection, index) => (
                        <Draggable
                          key={collection.id}
                          draggableId={collection.id}
                          index={index}
                        >
                          {(provided, snapshot) => (
                            <CollectionRow
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              collection={collection}
                              onUpdate={onUpdate}
                              onDelete={() =>
                                onDelete(collection.id, collection.name)
                              }
                              onRestore={() => onRestore(collection.id)}
                              onPermanentDelete={() =>
                                onDelete(collection.id, collection.name)
                              }
                              onToggleSelection={() =>
                                onToggleSelection(collection.id)
                              }
                              isSelected={selectedIds.has(collection.id)}
                              isSaving={savingStates[collection.id]}
                              isActionLoading={isActionLoading}
                              showTrashed={showTrashed}
                              dragHandleProps={provided.dragHandleProps}
                              isDragging={snapshot.isDragging}
                            />
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </>
                  )}
                  {!isLoading && collections.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="h-48 text-center text-muted-foreground"
                      >
                        <div className="flex flex-col items-center justify-center gap-3">
                          <Layers className="h-12 w-12 opacity-40" />
                          <div className="space-y-1">
                            <p className="font-medium text-lg">
                              {searchQuery
                                ? "No collections found"
                                : "No collections yet"}
                            </p>
                            <p className="text-sm">
                              {searchQuery
                                ? "Try adjusting your search query."
                                : "Create your first collection to get started."}
                            </p>
                          </div>
                          {!searchQuery && (
                            <Button onClick={onCreateClick} className="mt-2">
                              <Plus className="h-4 w-4 mr-2" />
                              New Collection
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              )}
            </Droppable>
          )}
        </Table>
      </DragDropContext>
    </div>
  );
}
