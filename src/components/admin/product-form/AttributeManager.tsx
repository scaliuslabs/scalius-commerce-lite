// src/components/admin/product-form/AttributeManager.tsx
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Plus,
  Trash2,
  Loader2,
  ChevronsUpDown,
  Check,
} from "lucide-react";
import { toast } from "sonner";
import type { ProductAttribute } from "@/db/schema";
import { cn } from "@/lib/utils";
import { AttributeCreateDialog } from "../attributes-manager/components/AttributeCreateDialog";

interface AssignedAttribute {
  attributeId: string;
  value: string;
  name?: string;
  slug?: string;
}

interface AttributeManagerProps {
  initialAttributes: AssignedAttribute[];
  onAttributesChange: (
    attributes: Omit<AssignedAttribute, "name" | "slug">[],
  ) => void;
}

interface AttributeDefinition extends ProductAttribute {}

export function AttributeManager({
  initialAttributes,
  onAttributesChange,
}: AttributeManagerProps) {
  const [assignedAttributes, setAssignedAttributes] = useState<
    AssignedAttribute[]
  >([]);
  const [availableAttributes, setAvailableAttributes] = useState<
    AttributeDefinition[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);

  // Create Attribute Dialog
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newAttribute, setNewAttribute] = useState({
    name: "",
    slug: "",
    filterable: true,
    options: [] as string[],
  });
  const [isCreating, setIsCreating] = useState(false);

  const fetchAllAttributes = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/attributes?limit=999");
      if (!response.ok) throw new Error("Failed");
      const data = await response.json();
      setAvailableAttributes(data.data);
      return data.data as AttributeDefinition[];
    } catch {
      toast.error("Could not load attributes");
      return [];
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllAttributes().then((fullAttrs) => {
      const enhanced = initialAttributes.map((attr) => {
        const def = fullAttrs.find((d) => d.id === attr.attributeId);
        return {
          ...attr,
          name: def?.name || attr.name || "Unknown",
          slug: def?.slug || attr.slug || "",
        };
      });
      setAssignedAttributes(enhanced);
    });
  }, [initialAttributes, fetchAllAttributes]);

  const updateParent = (updated: AssignedAttribute[]) => {
    onAttributesChange(
      updated.map((a) => ({ attributeId: a.attributeId, value: a.value })),
    );
  };

  const handleCreateAttribute = async () => {
    if (!newAttribute.name.trim() || !newAttribute.slug.trim()) return;
    setIsCreating(true);
    try {
      const response = await fetch("/api/admin/attributes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newAttribute),
      });
      if (!response.ok) throw new Error("Failed");
      const data = await response.json();
      const created = data.data;

      toast.success("Attribute created");
      setAvailableAttributes((prev) => [...prev, created]);
      handleAddAttribute(created.id);
      setIsCreateDialogOpen(false);
      setNewAttribute({ name: "", slug: "", filterable: true, options: [] });
    } catch {
      toast.error("Failed to create attribute");
    } finally {
      setIsCreating(false);
    }
  };

  const handleAddAttribute = (attrId: string) => {
    const def = availableAttributes.find((a) => a.id === attrId);
    if (!def || assignedAttributes.some((a) => a.attributeId === attrId))
      return;
    const newAttrs = [
      ...assignedAttributes,
      { attributeId: def.id, value: "", name: def.name, slug: def.slug },
    ];
    setAssignedAttributes(newAttrs);
    updateParent(newAttrs);
  };

  const handleRemoveAttribute = (index: number) => {
    const newAttrs = assignedAttributes.filter((_, i) => i !== index);
    setAssignedAttributes(newAttrs);
    updateParent(newAttrs);
  };

  const handleValueChange = (index: number, val: string) => {
    const newAttrs = [...assignedAttributes];
    newAttrs[index].value = val;
    setAssignedAttributes(newAttrs);
    updateParent(newAttrs);
  };

  if (isLoading)
    return (
      <div className="p-4 flex justify-center">
        <Loader2 className="animate-spin text-muted-foreground" />
      </div>
    );

  return (
    <div className="space-y-4">
      <AttributeCreateDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        newAttribute={newAttribute}
        isCreating={isCreating}
        onNameChange={(e) => {
          const name = e.target.value;
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          setNewAttribute((p) => ({ ...p, name, slug: slug }));
        }}
        onSlugChange={(s) => setNewAttribute((p) => ({ ...p, slug: s }))}
        onFilterableChange={(c) =>
          setNewAttribute((p) => ({ ...p, filterable: c }))
        }
        onOptionsChange={(o) => setNewAttribute((p) => ({ ...p, options: o }))}
        onCreate={handleCreateAttribute}
      />

      <div className="space-y-3">
        {assignedAttributes.map((attr, index) => (
          <div
            key={`${attr.attributeId}-${index}`}
            className="flex items-start gap-3 p-3 border rounded-lg bg-card group"
          >
            <div className="w-[140px] shrink-0 pt-2 hidden sm:block">
              <label className="text-sm font-medium">{attr.name}</label>
              <p className="text-xs text-muted-foreground mt-1 font-mono">
                {attr.slug}
              </p>
            </div>
            <div className="flex-1 min-w-0">
              <div className="sm:hidden text-sm font-medium mb-1">
                {attr.name}
              </div>
              <AttributeValueSelector
                attributeId={attr.attributeId}
                value={attr.value}
                onChange={(v) => handleValueChange(index, v)}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => handleRemoveAttribute(index)}
              className="h-10 w-10 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="relative">
        <AttributeDefinitionCombobox
          attributes={availableAttributes}
          assignedIds={new Set(assignedAttributes.map((a) => a.attributeId))}
          onSelect={handleAddAttribute}
          onCreate={() => setIsCreateDialogOpen(true)}
        />
      </div>

      {assignedAttributes.length === 0 && (
        <div className="text-center p-6 border-2 border-dashed rounded-lg bg-muted/10 text-muted-foreground text-sm">
          No attributes added yet.
        </div>
      )}
    </div>
  );
}

// Subcomponents

function AttributeDefinitionCombobox({
  attributes,
  assignedIds,
  onSelect,
  onCreate,
}: any) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-start pl-3 text-muted-foreground font-normal"
        >
          <Plus className="mr-2 h-4 w-4" /> Add Attribute...
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search attributes..." />
          <CommandList>
            <CommandEmpty>
              No attribute found.{" "}
              <Button
                variant="link"
                onClick={() => {
                  setOpen(false);
                  onCreate();
                }}
              >
                Create new
              </Button>
            </CommandEmpty>
            <CommandGroup>
              {attributes.map((attr: any) => (
                <CommandItem
                  key={attr.id}
                  value={attr.name}
                  onSelect={() => {
                    onSelect(attr.id);
                    setOpen(false);
                  }}
                  disabled={assignedIds.has(attr.id)}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      assignedIds.has(attr.id) ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {attr.name}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  setOpen(false);
                  onCreate();
                }}
              >
                <Plus className="mr-2 h-4 w-4" /> Create new attribute
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

interface FetchedValue {
  value: string;
  isPreset: boolean;
}

function AttributeValueSelector({
  attributeId,
  value,
  onChange,
}: {
  attributeId: string;
  value: string;
  onChange: (val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FetchedValue[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchValues = useCallback(
    async (pageNum: number, text: string, reset = false) => {
      setLoading(true);
      try {
        const p = new URLSearchParams();
        p.set("page", pageNum.toString());
        p.set("limit", "10");
        p.set("sort", "desc");
        if (text) p.set("search", text);

        const res = await fetch(
          `/api/admin/attributes/${attributeId}/values?${p.toString()}`,
        );
        if (!res.ok) return;
        const data = await res.json();

        setItems((prev) => (reset ? data.values : [...prev, ...data.values]));
        setHasMore(data.values.length === 10);
      } finally {
        setLoading(false);
      }
    },
    [attributeId],
  );

  useEffect(() => {
    if (open) {
      setPage(1);
      fetchValues(1, "", true);
    }
  }, [open, attributeId, fetchValues]);

  // Debounce search update
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      setPage(1);
      fetchValues(1, search, true);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, open, fetchValues]);

  const handleCreate = async () => {
    onChange(search);
    setOpen(false);
    try {
      await fetch(`/api/admin/attributes/${attributeId}/values`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: search }),
      });
    } catch {}
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between h-10 px-3 font-normal text-left"
        >
          {value ? (
            <span className="text-foreground">{value}</span>
          ) : (
            <span className="text-muted-foreground">
              Select or type value...
            </span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search values..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && page === 1 && (
              <div className="py-6 text-center text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
                Loading...
              </div>
            )}
            {!loading && items.length === 0 && (
              <CommandEmpty className="py-2 px-2">
                <p className="text-xs text-muted-foreground mb-2 text-center">
                  No results.
                </p>
                {search && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full h-8"
                    onClick={handleCreate}
                  >
                    Create "{search}"
                  </Button>
                )}
              </CommandEmpty>
            )}

            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.value}
                  value={item.value}
                  onSelect={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === item.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {item.value}
                  {item.isPreset && (
                    <span className="ml-2 text-[10px] bg-muted px-1 rounded text-muted-foreground">
                      Preset
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>

            {hasMore && (
              <div className="p-1 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs h-7"
                  disabled={loading}
                  onClick={(e) => {
                    e.preventDefault();
                    const n = page + 1;
                    setPage(n);
                    fetchValues(n, search);
                  }}
                >
                  {loading ? "Loading..." : "Load more"}
                </Button>
              </div>
            )}

            {search &&
              !items.some(
                (i) => i.value.toLowerCase() === search.toLowerCase(),
              ) && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    <CommandItem onSelect={handleCreate}>
                      <Plus className="mr-2 h-4 w-4" /> Create "{search}"
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
