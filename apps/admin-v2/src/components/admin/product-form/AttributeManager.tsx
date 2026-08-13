// src/components/admin/product-form/AttributeManager.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { AlertCircle, Check, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@scalius/shared/utils";
import { getServerFnError } from "@/lib/api-helpers";
import { useCatalogActionPermissions } from "@/hooks/use-catalog-action-permissions";
import {
  addAttributeValue,
  createAttribute,
  getAttributes,
  getAttributeValues,
  type AttributeDto,
} from "@/lib/api-functions/attributes";
import {
  attributeAssignmentSignature,
  mergeAttributeValuePages,
} from "./attribute-manager.helpers";

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

type AttributeDefinition = AttributeDto;

function definitionMapFromAssignments(assignments: AssignedAttribute[]) {
  const definitions = new Map<string, AttributeDefinition>();
  for (const assignment of assignments) {
    if (!assignment.name) continue;
    definitions.set(assignment.attributeId, {
      id: assignment.attributeId,
      name: assignment.name,
      slug: assignment.slug ?? "",
      filterable: false,
      options: null,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    });
  }
  return definitions;
}

export function AttributeManager({
  initialAttributes,
  onAttributesChange,
}: AttributeManagerProps) {
  const { attributes: attributeActions } = useCatalogActionPermissions();
  const [assignedAttributes, setAssignedAttributes] = useState<AssignedAttribute[]>(
    () => initialAttributes.map((attribute) => ({ ...attribute })),
  );
  const [definitions, setDefinitions] = useState<Map<string, AttributeDefinition>>(
    () => definitionMapFromAssignments(initialAttributes),
  );
  const [definitionLookupLoading, setDefinitionLookupLoading] = useState(false);
  const [definitionLookupFailed, setDefinitionLookupFailed] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const lastEmittedSignature = useRef<string | null>(null);
  const lastAppliedIncomingSignature = useRef(attributeAssignmentSignature(initialAttributes));
  const definitionLookupRequest = useRef(0);

  const incomingSignature = attributeAssignmentSignature(initialAttributes);
  const incomingIdsKey = useMemo(
    () => [...new Set(initialAttributes.map((attribute) => attribute.attributeId.trim()).filter(Boolean))]
      .sort()
      .join(","),
    [initialAttributes],
  );

  useEffect(() => {
    if (lastEmittedSignature.current === incomingSignature) {
      lastAppliedIncomingSignature.current = incomingSignature;
      return;
    }
    if (lastAppliedIncomingSignature.current === incomingSignature) return;
    lastAppliedIncomingSignature.current = incomingSignature;
    setAssignedAttributes(initialAttributes.map((attribute) => ({ ...attribute })));
  }, [incomingSignature, initialAttributes]);

  useEffect(() => {
    if (!incomingIdsKey) {
      setDefinitionLookupLoading(false);
      setDefinitionLookupFailed(false);
      return;
    }
    const requestId = ++definitionLookupRequest.current;
    setDefinitionLookupLoading(true);
    setDefinitionLookupFailed(false);
    void getAttributes({
      data: { ids: incomingIdsKey, limit: 90, sort: "name", order: "asc" },
    }).then((data) => {
      if (requestId !== definitionLookupRequest.current) return;
      setDefinitions((current) => {
        const next = new Map(current);
        for (const definition of data.attributes) next.set(definition.id, definition);
        return next;
      });
    }).catch(() => {
      if (requestId === definitionLookupRequest.current) setDefinitionLookupFailed(true);
    }).finally(() => {
      if (requestId === definitionLookupRequest.current) setDefinitionLookupLoading(false);
    });
  }, [incomingIdsKey]);

  const rememberDefinitions = useCallback((loaded: AttributeDefinition[]) => {
    setDefinitions((current) => {
      const next = new Map(current);
      for (const definition of loaded) next.set(definition.id, definition);
      return next;
    });
  }, []);

  const commitAssignments = useCallback((updated: AssignedAttribute[]) => {
    setAssignedAttributes(updated);
    const stripped = updated.map(({ attributeId, value }) => ({ attributeId, value }));
    lastEmittedSignature.current = attributeAssignmentSignature(stripped);
    onAttributesChange(stripped);
  }, [onAttributesChange]);

  const handleCreateAttribute = async (rawName: string): Promise<boolean> => {
    const name = rawName.trim();
    if (!name) return false;
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (slug.length < 2) {
      toast.error("Use at least two letters or numbers for the attribute name");
      return false;
    }

    setIsCreating(true);
    try {
      const data = await createAttribute({
        data: { name, slug, filterable: true, options: [] },
      });
      const created = data.attribute;
      rememberDefinitions([{
        ...created,
        options: null,
        createdAt: 0,
        updatedAt: 0,
        deletedAt: null,
      }]);
      commitAssignments([
        ...assignedAttributes,
        { attributeId: created.id, value: "", name: created.name, slug: created.slug },
      ]);
      toast.success("Attribute created. Choose a value to finish the assignment.");
      return true;
    } catch (error: unknown) {
      toast.error(getServerFnError(error, "Failed to create attribute"));
      return false;
    } finally {
      setIsCreating(false);
    }
  };

  const handleAddAttribute = (definition: AttributeDefinition) => {
    if (assignedAttributes.some((item) => item.attributeId === definition.id)) return;
    if (assignedAttributes.length >= 90) {
      toast.error("A product can have at most 90 attributes");
      return;
    }
    rememberDefinitions([definition]);
    commitAssignments([
      ...assignedAttributes,
      { attributeId: definition.id, value: "", name: definition.name, slug: definition.slug },
    ]);
  };

  const handleValueChange = (index: number, value: string) => {
    commitAssignments(assignedAttributes.map((attribute, itemIndex) =>
      itemIndex === index ? { ...attribute, value } : attribute));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {assignedAttributes.map((attribute, index) => {
          const definition = definitions.get(attribute.attributeId);
          const unavailable = !definitionLookupLoading && !definitionLookupFailed && !definition;
          const label = definition?.name ?? attribute.name ?? (
            definitionLookupLoading ? "Loading attribute…" : "Unavailable attribute"
          );
          const needsValue = attribute.value.trim().length === 0;

          return (
            <div
              key={attribute.attributeId}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_2rem] gap-x-2 gap-y-1 rounded-md border bg-card p-2 sm:grid-cols-[9rem_minmax(0,1fr)_2rem]",
                (needsValue || unavailable) && "border-amber-300/80",
              )}
            >
              <div className="min-w-0 self-center sm:row-span-2">
                <div className="truncate text-sm font-medium" title={label}>{label}</div>
                {unavailable && (
                  <div className="text-xs text-amber-700">Removed or in trash</div>
                )}
              </div>
              <div className="min-w-0 sm:col-start-2">
                <AttributeValueSelector
                  attributeId={attribute.attributeId}
                  attributeName={label}
                  value={attribute.value}
                  canSavePreset={attributeActions.canEdit && !unavailable}
                  disabled={unavailable}
                  onChange={(value) => handleValueChange(index, value)}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove ${label}`}
                onClick={() => commitAssignments(
                  assignedAttributes.filter((_, itemIndex) => itemIndex !== index),
                )}
                className="col-start-2 row-start-1 h-8 w-8 text-muted-foreground hover:text-destructive sm:col-start-3"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              {needsValue && !unavailable && (
                <p className="col-span-2 text-xs text-amber-700 sm:col-start-2 sm:col-span-1">
                  Choose or enter a value before saving.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <AttributeDefinitionCombobox
        assignedIds={new Set(assignedAttributes.map((attribute) => attribute.attributeId))}
        canCreate={attributeActions.canCreate}
        disabled={assignedAttributes.length >= 90}
        isCreating={isCreating}
        onDefinitionsLoaded={rememberDefinitions}
        onSelect={handleAddAttribute}
        onCreate={handleCreateAttribute}
      />

      {definitionLookupFailed && assignedAttributes.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          Attribute names could not be refreshed. Existing values are preserved.
        </p>
      )}
      {assignedAttributes.length === 0 && (
        <div className="rounded-md border border-dashed bg-muted/10 px-3 py-4 text-center text-sm text-muted-foreground">
          Add facts such as brand, material, warranty, or care instructions.
        </div>
      )}
    </div>
  );
}

function AttributeDefinitionCombobox({
  assignedIds,
  canCreate,
  disabled,
  isCreating,
  onDefinitionsLoaded,
  onSelect,
  onCreate,
}: {
  assignedIds: Set<string>;
  canCreate: boolean;
  disabled: boolean;
  isCreating: boolean;
  onDefinitionsLoaded: (definitions: AttributeDefinition[]) => void;
  onSelect: (definition: AttributeDefinition) => void;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<AttributeDefinition[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadDefinitions = useCallback(async (pageNumber: number, reset: boolean) => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getAttributes({
        data: {
          page: pageNumber,
          limit: 25,
          search: search.trim(),
          sort: "name",
          order: "asc",
        },
      });
      if (requestId !== requestSequence.current) return;
      setItems((current) => reset
        ? data.attributes
        : [...new Map([...current, ...data.attributes].map((item) => [item.id, item])).values()]);
      setPage(data.pagination.page);
      setTotalPages(data.pagination.totalPages);
      onDefinitionsLoaded(data.attributes);
    } catch (loadError: unknown) {
      if (requestId === requestSequence.current) {
        setError(getServerFnError(loadError, "Could not load attributes"));
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [onDefinitionsLoaded, search]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(
      () => void loadDefinitions(1, true),
      search ? 250 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [open, search, loadDefinitions]);

  const normalizedSearch = search.trim().toLowerCase();
  const exactMatch = items.some((item) => item.name.trim().toLowerCase() === normalizedSearch);

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) setSearch("");
    }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-expanded={open}
          className="h-9 w-full justify-start px-3 font-normal text-muted-foreground"
        >
          <Plus className="mr-2 h-4 w-4" />
          {disabled ? "Attribute limit reached" : "Add attribute"}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={12}
        className="w-[var(--radix-popover-trigger-width)] min-w-[20rem] max-w-[calc(100vw-1.5rem)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search attributes…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && items.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading attributes…
              </div>
            )}
            {error && (
              <div className="space-y-2 p-3 text-center text-sm text-destructive">
                <p>{error}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void loadDefinitions(1, true)}>
                  <RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry
                </Button>
              </div>
            )}
            {!loading && !error && items.length === 0 && (
              <CommandEmpty className="px-3 py-5 text-center text-sm text-muted-foreground">
                No matching attributes.
              </CommandEmpty>
            )}
            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.id}
                  disabled={assignedIds.has(item.id)}
                  onSelect={() => {
                    onSelect(item);
                    setOpen(false);
                  }}
                  className="text-sm"
                >
                  <Check className={cn("mr-2 h-4 w-4", assignedIds.has(item.id) ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="ml-3 truncate text-xs text-muted-foreground">{item.slug}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {page < totalPages && !error && (
              <div className="border-t p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full text-sm"
                  disabled={loading}
                  onClick={() => void loadDefinitions(page + 1, false)}
                >
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            )}
            {canCreate && normalizedSearch && !exactMatch && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    disabled={isCreating}
                    onSelect={() => void onCreate(search).then((created) => {
                      if (created) setOpen(false);
                    })}
                    className="text-sm"
                  >
                    {isCreating
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : <Plus className="mr-2 h-4 w-4" />}
                    Create “{search.trim()}”
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

interface FetchedValue {
  value: string;
  isPreset: boolean;
}

function AttributeValueSelector({
  attributeId,
  attributeName,
  value,
  canSavePreset,
  disabled,
  onChange,
}: {
  attributeId: string;
  attributeName: string;
  value: string;
  canSavePreset: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FetchedValue[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const requestSequence = useRef(0);

  const loadValues = useCallback(async (pageNumber: number, reset: boolean) => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getAttributeValues({
        data: {
          attributeId,
          page: pageNumber,
          limit: 20,
          sort: "asc",
          ...(search.trim() ? { search: search.trim() } : {}),
        },
      });
      if (requestId !== requestSequence.current) return;
      setItems((current) => reset
        ? mergeAttributeValuePages([], data.values)
        : mergeAttributeValuePages(current, data.values));
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (loadError: unknown) {
      if (requestId === requestSequence.current) {
        setError(getServerFnError(loadError, "Could not load values"));
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [attributeId, search]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void loadValues(1, true), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [open, search, loadValues]);

  const useCustomValue = () => {
    const nextValue = search.trim();
    if (!nextValue) return;
    onChange(nextValue);
    setOpen(false);
  };

  const savePresetAndUse = async () => {
    const nextValue = search.trim();
    if (!nextValue) return;
    setSavingPreset(true);
    try {
      await addAttributeValue({ data: { attributeId, value: nextValue } });
      setItems((current) => mergeAttributeValuePages(current, [{ value: nextValue, isPreset: true }]));
      onChange(nextValue);
      setOpen(false);
      toast.success(`Saved “${nextValue}” as a reusable ${attributeName} value`);
    } catch (saveError: unknown) {
      toast.error(getServerFnError(saveError, "Could not save preset value"));
    } finally {
      setSavingPreset(false);
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const exactMatch = items.some((item) => item.value.trim().toLowerCase() === normalizedSearch);

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) setSearch("");
    }}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={`${attributeName} value`}
          aria-expanded={open}
          aria-invalid={!value.trim()}
          disabled={disabled}
          className="h-8 w-full justify-between px-2.5 text-left text-sm font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || "Choose or enter a value…"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={12}
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] max-w-[calc(100vw-1.5rem)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${attributeName.toLowerCase()} values…`}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && items.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading values…
              </div>
            )}
            {error && (
              <div className="space-y-2 p-3 text-center text-sm text-destructive">
                <p>{error}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void loadValues(1, true)}>
                  <RotateCcw className="mr-2 h-3.5 w-3.5" /> Retry
                </Button>
              </div>
            )}
            {!loading && !error && items.length === 0 && !normalizedSearch && (
              <CommandEmpty className="px-3 py-5 text-center text-sm text-muted-foreground">
                No saved values yet. Type a value to use it for this product.
              </CommandEmpty>
            )}
            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.value.trim().toLowerCase()}
                  value={item.value}
                  onSelect={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                  className="text-sm"
                >
                  <Check className={cn("mr-2 h-4 w-4", value === item.value ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 truncate">{item.value}</span>
                  {item.isPreset && <span className="ml-2 text-xs text-muted-foreground">Preset</span>}
                </CommandItem>
              ))}
            </CommandGroup>
            {page < totalPages && !error && (
              <div className="border-t p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full text-sm"
                  disabled={loading}
                  onClick={() => void loadValues(page + 1, false)}
                >
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            )}
            {normalizedSearch && !exactMatch && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={useCustomValue} className="text-sm">
                    <Plus className="mr-2 h-4 w-4" /> Use “{search.trim()}” for this product
                  </CommandItem>
                  {canSavePreset && (
                    <CommandItem disabled={savingPreset} onSelect={() => void savePresetAndUse()} className="text-sm">
                      {savingPreset
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <Plus className="mr-2 h-4 w-4" />}
                      Save as preset and use
                    </CommandItem>
                  )}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
