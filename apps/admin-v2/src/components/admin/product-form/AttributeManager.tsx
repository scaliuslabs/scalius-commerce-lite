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
import { translate, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import {
  getApiV1AdminAttributes,
  postApiV1AdminAttributes,
  postApiV1AdminAttributesByIdValues,
} from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import {
  getAttributeValues,
  type AttributeDto,
} from "@/lib/api-query-options/attributes";
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
  /** Rows the last check found without a value (shown once Save was pressed, not while adding). */
  missingValueRows?: ReadonlySet<number>;
}

type AttributeDefinition = Omit<AttributeDto, "valueCount"> & { valueCount?: number };

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
  missingValueRows,
}: AttributeManagerProps) {
  const t = useMessages(productMessages);
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
    void apiData(getApiV1AdminAttributes({
      query: { ids: incomingIdsKey, limit: 90, sort: "name", order: "asc" },
    })).then((data) => {
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
      toast.error(t("attributeNameShort"));
      return false;
    }

    setIsCreating(true);
    try {
      const data = await apiData(postApiV1AdminAttributes({
        body: { name, slug, filterable: true, options: [] },
      }));
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
      toast.success(t("attributeCreated"));
      return true;
    } catch (error: unknown) {
      toast.error(getServerFnError(error, translate(resourceMessages, "actionFailed")));
      return false;
    } finally {
      setIsCreating(false);
    }
  };

  const handleAddAttribute = (definition: AttributeDefinition) => {
    if (assignedAttributes.some((item) => item.attributeId === definition.id)) return;
    if (assignedAttributes.length >= 90) {
      toast.error(t("attributeLimit", { max: 90 }));
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
      <div className="divide-y">
        {assignedAttributes.map((attribute, index) => {
          const definition = definitions.get(attribute.attributeId);
          const unavailable = !definitionLookupLoading && !definitionLookupFailed && !definition;
          const label = definition?.name ?? attribute.name ?? t(
            definitionLookupLoading ? "loading" : "attributeRemoved",
          );
          const needsValue = attribute.value.trim().length === 0 && Boolean(missingValueRows?.has(index));

          return (
            <div key={attribute.attributeId} className="flex flex-wrap items-start gap-2 py-2 sm:flex-nowrap">
              <div className="min-w-0 flex-1 text-body font-medium sm:w-36 sm:flex-none sm:pt-2" title={label}>
                <span className="block truncate">{label}</span>
                {unavailable && attribute.name ? (
                  <span className="block font-normal text-destructive">{t("attributeRemoved")}</span>
                ) : null}
              </div>
              <div className="order-last w-full space-y-1 sm:order-none sm:w-auto sm:flex-1">
                <AttributeValueSelector
                  attributeId={attribute.attributeId}
                  attributeName={label}
                  value={attribute.value}
                  canSavePreset={attributeActions.canEdit && !unavailable}
                  disabled={unavailable}
                  onChange={(value) => handleValueChange(index, value)}
                />
                {needsValue && !unavailable ? (
                  <p className="text-body text-destructive">{t("attributeNeedsValue")}</p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("removeAttribute", { name: label })}
                onClick={() => commitAssignments(
                  assignedAttributes.filter((_, itemIndex) => itemIndex !== index),
                )}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
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
        <p className="flex items-start gap-2 text-body text-destructive">
          <span className="flex h-5 shrink-0 items-center"><AlertCircle className="h-4 w-4" /></span>
          {t("attributeNamesFailed")}
        </p>
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
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
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
      const data = await apiData(getApiV1AdminAttributes({
        query: {
          page: pageNumber,
          limit: 25,
          search: search.trim() || undefined,
          sort: "name",
          order: "asc",
        },
      }));
      if (requestId !== requestSequence.current) return;
      setItems((current) => reset
        ? data.attributes
        : [...new Map([...current, ...data.attributes].map((item) => [item.id, item])).values()]);
      setPage(data.pagination.page);
      setTotalPages(data.pagination.totalPages);
      onDefinitionsLoaded(data.attributes);
    } catch (loadError: unknown) {
      if (requestId === requestSequence.current) {
        setError(getServerFnError(loadError, translate(resourceMessages, "loadFailed")));
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
          className="w-full justify-start"
        >
          <Plus className="mr-2 h-4 w-4" />
          {t("addAttribute")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("searchAttributes")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && items.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-6 text-body text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t("loading")}
              </div>
            )}
            {error && (
              <div className="space-y-2 p-3 text-center text-body text-destructive">
                <p>{error}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void loadDefinitions(1, true)}>
                  <RotateCcw className="mr-2 h-4 w-4" /> {r("retry")}
                </Button>
              </div>
            )}
            {!loading && !error && items.length === 0 && (
              <CommandEmpty>{r("noResults")}</CommandEmpty>
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
                >
                  <Check className={cn("mr-2 h-4 w-4", assignedIds.has(item.id) ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {page < totalPages && !error && (
              <div className="border-t p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={loading}
                  onClick={() => void loadDefinitions(page + 1, false)}
                >
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {t("loadMore")}
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
                  >
                    {isCreating
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : <Plus className="mr-2 h-4 w-4" />}
                    {t("createNamed", { name: search.trim() })}
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
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
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
        attributeId,
        page: pageNumber,
        limit: 20,
        sort: "asc",
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      if (requestId !== requestSequence.current) return;
      setItems((current) => reset
        ? mergeAttributeValuePages([], data.values)
        : mergeAttributeValuePages(current, data.values));
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (loadError: unknown) {
      if (requestId === requestSequence.current) {
        setError(getServerFnError(loadError, translate(resourceMessages, "loadFailed")));
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
      await apiData(postApiV1AdminAttributesByIdValues({
        path: { id: attributeId },
        body: { value: nextValue },
      }));
      setItems((current) => mergeAttributeValuePages(current, [{ value: nextValue, isPreset: true }]));
      onChange(nextValue);
      setOpen(false);
      toast.success(t("valueSaved"));
    } catch (saveError: unknown) {
      toast.error(getServerFnError(saveError, translate(resourceMessages, "actionFailed")));
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
          aria-label={t("valueOf", { name: attributeName })}
          aria-expanded={open}
          aria-invalid={!value.trim()}
          disabled={disabled}
          className="w-full justify-between"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || t("chooseValue")}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-72 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("searchValues")}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {loading && items.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-6 text-body text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> {t("loading")}
              </div>
            )}
            {error && (
              <div className="space-y-2 p-3 text-center text-body text-destructive">
                <p>{error}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void loadValues(1, true)}>
                  <RotateCcw className="mr-2 h-4 w-4" /> {r("retry")}
                </Button>
              </div>
            )}
            {!loading && !error && items.length === 0 && !normalizedSearch && (
              <CommandEmpty>{t("noSavedValues")}</CommandEmpty>
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
                >
                  <Check className={cn("mr-2 h-4 w-4", value === item.value ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 truncate">{item.value}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {page < totalPages && !error && (
              <div className="border-t p-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={loading}
                  onClick={() => void loadValues(page + 1, false)}
                >
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {t("loadMore")}
                </Button>
              </div>
            )}
            {normalizedSearch && !exactMatch && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem onSelect={useCustomValue}>
                    <Plus className="mr-2 h-4 w-4" /> {t("useValue", { value: search.trim() })}
                  </CommandItem>
                  {canSavePreset && (
                    <CommandItem disabled={savingPreset} onSelect={() => void savePresetAndUse()}>
                      {savingPreset
                        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        : <Plus className="mr-2 h-4 w-4" />}
                      {t("saveAndUseValue")}
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
