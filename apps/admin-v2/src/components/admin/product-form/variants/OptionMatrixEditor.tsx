import React from "react";
import { WeightInput, useWeightUnit } from "./WeightInput";
import { formatWeight } from "./weight-format";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@scalius/shared/utils";
import { MAX_PRODUCT_OPTION_AXES, MAX_PRODUCT_OPTION_COMBINATIONS } from "@scalius/shared/product-options";
import {
  putApiV1AdminProductsByIdOptionsMatrix,
  putApiV1AdminProductsByIdVariantsByVariantId,
} from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { getServerFnError } from "@/lib/api-helpers";
import { readApiFieldIssues } from "@/lib/api-field-errors";
import { readProductRevisionConflict, type ProductRevisionConflict } from "@/lib/admin-api-conflicts";
import { queryKeys } from "@/lib/query-keys";
import {
  hasSeveralLocations,
  inventoryLocationKeys,
  inventoryLocationsQueryOptions,
  productInventoryLevelsQueryOptions,
} from "@/lib/api-query-options/inventory-locations";
import { SaveNotCompleted } from "../../shared/SaveBar";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { readSkuTaken } from "../hooks/useProductSubmit";
import { formatNumber, useMessages } from "~/i18n";
import { productVariantMessages } from "~/i18n/product-variants";
import { digitalMessages } from "~/i18n/digital";
import type {
  ProductSkuImageChoice,
  ProductOptionDefinition,
  ProductOptionStandardMapping,
  ProductVariant,
} from "~/lib/api-query-options/products";
import {
  ADVANCED_FIELDS,
  draftId,
  draftSignature,
  allocatedStock,
  getOptionMatrixIssue,
  getSimpleSkuIssue,
  initialOptions,
  initialSimpleSku,
  initialVariants,
  combinationKey,
  materializeCombination,
  materializeVariants,
  materializeVariantsExcluding,
  matrixSaveVariants,
  missingOptionCombinations,
  normalized,
  followProductDefaults,
  withGuessedOptionType,
  optionTopologySignature,
  type DraftIssue,
  type DraftIssueField,
  type DraftOption,
  type DraftVariant,
  type OptionMatrixEditorHandle,
  type ProductCreateComposition,
  type ProductFulfilmentMode,
  type ProductUpdateComposition,
  type SimpleSkuDraft,
  type VariantPriceRange,
  withFulfilmentMode,
} from "./option-matrix-editor-model";
import { constrainSkuForKind, digitalSkuTracks, isDigitalSku, productKindRules, useProductKindRules } from "../product-kind-rules";
import { DigitalStockStatus } from "../DigitalStock";
import { digitalAssetsQueryOptions, digitalSkuStock } from "../digital-stock";
import { useProductEditorSlots } from "../editor-slots";
import { usePublishSkuCostRows, useSkuCosts, type SkuCostRow } from "../sku-costs";
import { Field, FieldRow, ReadOnlyValue } from "~/components/ui/field";
import { barcodePatch, InventoryQuantityInput, type IncomingUnits, type IssueFor, type StockElsewhere } from "./variant-fields";
import { VariantTable, type VariantCosts } from "./VariantTable";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { usePermissions } from "~/contexts/PermissionContext";

const MAX_AXES = MAX_PRODUCT_OPTION_AXES;
const MAX_COMBINATIONS = MAX_PRODUCT_OPTION_COMBINATIONS;

/** Request body field → the editor field that shows it. */
const SERVER_FIELDS: Record<string, DraftIssueField> = {
  sku: "sku",
  price: "price",
  stock: "stock",
  expectedStockVersion: "stock",
  barcode: "barcode",
  barcodeType: "barcode",
  weight: "weight",
  discountType: "discount",
  discountPercentage: "discount",
  discountAmount: "discount",
  imageId: "photo",
};


type OptionMatrixEditorProps = {
  readOnly?: boolean;
  productId?: string;
  productName: string;
  productPrice: number;
  /** Active products need every variant priced above 0. */
  requirePositivePrice?: boolean;
  options?: ProductOptionDefinition[];
  variants?: ProductVariant[];
  images: ProductSkuImageChoice[];
  aggregateRevision?: number;
  onAggregateRevisionChange?: (revision: number) => void;
  onSaved?: () => void;
  onDraftChange?: (composition: ProductCreateComposition | null) => void;
  /** The draft's problem as one banner line ("M / White: …"), or null. */
  onDraftIssueChange?: (issue: string | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Retained SKU/cost drafts still need leave-page protection after edit access is revoked. */
  onNavigationDirtyChange?: (dirty: boolean) => void;
  /** The variants' price range while the product has options (they carry the prices), else null. */
  onPricesChange?: (range: VariantPriceRange | null) => void;
  onSavingChange?: (saving: boolean) => void;
  onRevisionConflict?: (conflict: ProductRevisionConflict) => void;
  /** The product's Fulfilment select: one kind for every SKU, or per variant (a column). */
  fulfilmentMode?: ProductFulfilmentMode;
};

// One array for "none saved": a default of `[]` is a new array on every render, which made the memos below and the draft effect run on every render (and, with a parent that stores the draft, loop).
const NO_OPTIONS: ProductOptionDefinition[] = [];
const NO_VARIANTS: ProductVariant[] = [];

// Permission changes project saved facts without discarding the retained editor draft.
export const OptionMatrixEditor = React.forwardRef<OptionMatrixEditorHandle, OptionMatrixEditorProps>(function OptionMatrixEditor(props, ref) {
  return <OptionMatrix {...props} ref={ref} />;
});

const OptionMatrix = React.forwardRef<OptionMatrixEditorHandle, OptionMatrixEditorProps>(function OptionMatrix({
  readOnly = false,
  productId,
  productName,
  productPrice,
  requirePositivePrice = false,
  options: savedOptions = NO_OPTIONS,
  variants: savedVariants = NO_VARIANTS,
  images,
  aggregateRevision,
  onAggregateRevisionChange,
  onSaved,
  onDraftChange,
  onDraftIssueChange,
  onDirtyChange,
  onNavigationDirtyChange,
  onPricesChange,
  onSavingChange,
  onRevisionConflict,
  fulfilmentMode = "physical",
}, ref) {
  const t = useMessages(productVariantMessages);
  const weightUnit = useWeightUnit();
  const d = useMessages(digitalMessages);
  const queryClient = useQueryClient();
  const defaultSku = savedVariants.find((variant) => variant.isDefault && !variant.deletedAt);
  const [simpleSkuDraft, setSimpleSku] = React.useState<SimpleSkuDraft>(() => initialSimpleSku(defaultSku));
  const [simpleStockEdited, setSimpleStockEdited] = React.useState(false);
  // Quantities need "Adjust stock" (products.adjust_stock); the rest of the SKU follows products.edit.
  const canAdjustStock = usePermissions().hasPermission(PERMISSIONS.PRODUCTS_ADJUST_STOCK);
  const [optionDraft, setOptions] = React.useState<DraftOption[]>(() => initialOptions(savedOptions));
  const [variantDraft, setVariants] = React.useState<DraftVariant[]>(() => initialVariants(savedVariants));
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const simpleSku = React.useMemo(() => readOnly ? initialSimpleSku(defaultSku) : simpleSkuDraft, [readOnly, defaultSku, simpleSkuDraft]);
  const options = React.useMemo(() => readOnly ? initialOptions(savedOptions) : optionDraft, [readOnly, savedOptions, optionDraft]);
  const variants = React.useMemo(() => readOnly ? initialVariants(savedVariants) : variantDraft, [readOnly, savedVariants, variantDraft]);
  // Dirty is the draft against the last saved one: an edit changed back is no change.
  const draft = React.useMemo(() => draftSignature(simpleSkuDraft, optionDraft, variantDraft), [simpleSkuDraft, optionDraft, variantDraft]);
  const [savedDraft, setSavedDraft] = React.useState(draft);
  const sentDraft = React.useRef(draft);
  const dirty = draft !== savedDraft;
  const [revealed, setRevealed] = React.useState(false);
  const [revealNonce, setRevealNonce] = React.useState(0);
  const [serverIssue, setServerIssue] = React.useState<DraftIssue | null>(null);
  const [combinationsPending, setCombinationsPending] = React.useState(false);
  const [topologyChanged, setTopologyChanged] = React.useState(false);
  const [excludedCombinationKeys, setExcludedCombinationKeys] = React.useState<Set<string>>(() => new Set(
    missingOptionCombinations(initialOptions(savedOptions), initialVariants(savedVariants)).map(combinationKey),
  ));
  const [omittedVariantsByKey, setOmittedVariantsByKey] = React.useState<Map<string, DraftVariant>>(() => new Map());
  // The product's kind (a gift card) limits what its SKUs may be: the table, the checks and
  // the save all use these constrained rows, while the drafts keep what the merchant typed
  // (switching the kind back restores it). Saved SKUs keep their recorded quantity, so a
  // save never writes stock; new rows start at 0.
  // The form provides the gift-card flag; the kind comes with this editor's own Fulfilment prop.
  const { giftCard } = useProductKindRules();
  const kindRules = React.useMemo(
    () => productKindRules({ isGiftCard: giftCard, fulfillmentKind: fulfilmentMode }),
    [fulfilmentMode, giftCard],
  );
  // A product without options that is digital: its quantity is its licence keys (or unlimited files).
  const digitalSimple = isDigitalSku(kindRules, {});
  // A digital SKU tracks quantity exactly when it has a licence-key pool (its keys are its
  // stock; files are unlimited): read from the product's pools, never typed in.
  const digitalAssets = useQuery({
    ...digitalAssetsQueryOptions(productId ?? ""),
    enabled: Boolean(productId) && (kindRules.fulfilmentMode === "digital" || kindRules.fulfilmentMode === "mixed"),
  });
  const hasKeyPool = React.useCallback((variantId: string | undefined): boolean | undefined => {
    if (!variantId || variantId.startsWith("draft_")) return false;
    if (!productId) return false;
    return digitalAssets.data ? digitalSkuStock(variantId, digitalAssets.data).keys !== null : undefined;
  }, [digitalAssets.data, productId]);
  // One constrained row per draft row and rules, so an edit re-renders only the edited row.
  // A digital SKU's stock is its licence keys: a saved one shows (and saves) its recorded stock, never a typed one.
  const constrained = React.useMemo(() => ({
    rules: kindRules,
    rows: new WeakMap<DraftVariant, DraftVariant>(),
    saved: new Map(savedVariants.map((variant) => [variant.id, variant])),
    hasKeyPool,
  }), [kindRules, savedVariants, hasKeyPool]);
  const shownVariants = React.useMemo(() => variants.map((variant) => {
    let shown = constrained.rows.get(variant);
    if (!shown) {
      shown = constrainSkuForKind(variant, constrained.rules, !variant.id.startsWith("draft_"));
      const saved = constrained.saved.get(variant.id);
      if (isDigitalSku(constrained.rules, shown)) {
        if (saved !== undefined && shown.stock !== saved.stock) shown = { ...shown, stock: saved.stock };
        const tracks = digitalSkuTracks(saved ?? null, constrained.hasKeyPool(variant.id));
        if (shown.trackInventory !== tracks) shown = { ...shown, trackInventory: tracks };
      }
      constrained.rows.set(variant, shown);
    }
    return shown;
  }), [constrained, variants]);
  const shownSimpleSku = React.useMemo(() => {
    const shown = constrainSkuForKind(simpleSku, kindRules, Boolean(defaultSku));
    if (!digitalSimple) return shown;
    const tracks = digitalSkuTracks(defaultSku ?? null, hasKeyPool(defaultSku?.id));
    return {
      ...shown,
      trackInventory: tracks,
      ...(defaultSku && shown.stock !== defaultSku.stock ? { stock: defaultSku.stock } : {}),
    };
  }, [defaultSku, digitalSimple, hasKeyPool, kindRules, simpleSku]);
  const slots = useProductEditorSlots();
  const keepsTracking = digitalSimple && hasKeyPool(defaultSku?.id) === true;
  const savedOptionDraft = React.useMemo(() => initialOptions(savedOptions), [savedOptions]);
  const savedTopology = React.useMemo(() => optionTopologySignature(savedOptionDraft), [savedOptionDraft]);
  // Stock that must reach the new rows (the server's rule): a simple product's stock when
  // options are first added, or the stock of saved variants an option change replaces.
  // Variants that are only removed keep their stock on record (see the removal dialog).
  const liveIds = new Set(variants.map((variant) => variant.id));
  const replacedVariants = topologyChanged && variants.some((variant) => variant.id.startsWith("draft_"))
    ? savedVariants.filter((variant) => !variant.isDefault && !variant.deletedAt && !liveIds.has(variant.id))
    : [];
  const simpleConversion = savedOptions.length === 0 && Boolean(defaultSku?.trackInventory);
  // Untracked kinds (gift cards) carry no quantity to new rows.
  const requiredStockAllocation = !kindRules.showInventory ? 0 : simpleConversion
    ? defaultSku!.stock
    : replacedVariants.reduce((total, variant) => total + (variant.trackInventory ? variant.stock : 0), 0);
  const blockedCommittedStock = savedOptions.length === 0 ? defaultSku?.reservedStock ?? 0 : 0;
  const committedByVariantId = React.useMemo(
    () => new Map(savedVariants.map((variant) => [variant.id, variant.reservedStock])),
    [savedVariants],
  );
  // Several locations: quantities here are the default location's (where editor
  // edits are booked); units elsewhere show as a read-only breakdown per SKU.
  const { data: locations } = useQuery(inventoryLocationsQueryOptions());
  const severalLocations = kindRules.showInventory && hasSeveralLocations(locations);
  const homeLocation = severalLocations ? locations?.find((location) => location.isDefault) ?? null : null;
  // Per-location levels (several locations) and units on their way (open
  // purchase orders, transfers in transit), in one read for the saved SKUs.
  const { data: productLevels } = useQuery({
    ...productInventoryLevelsQueryOptions(productId ?? ""),
    enabled: Boolean(productId) && kindRules.showInventory,
  });
  const incomingByVariant = React.useMemo(() => {
    const byVariant = new Map<string, IncomingUnits>();
    for (const row of productLevels?.incoming ?? []) {
      const current = byVariant.get(row.variantId) ?? { purchaseOrders: 0, transfers: 0 };
      byVariant.set(row.variantId, {
        purchaseOrders: current.purchaseOrders + row.purchaseOrders,
        transfers: current.transfers + row.transfers,
      });
    }
    return byVariant;
  }, [productLevels]);
  const stockElsewhere = React.useMemo(() => {
    const byVariant = new Map<string, StockElsewhere>();
    if (!homeLocation || !productLevels || !locations) return byVariant;
    const order = new Map(locations.map((location, index) => [location.id, index]));
    const locationName = new Map(locations.map((location) => [location.id, location.name]));
    const levelsByVariant = new Map<string, typeof productLevels.levels>();
    for (const level of productLevels.levels) {
      levelsByVariant.set(level.variantId, [...(levelsByVariant.get(level.variantId) ?? []), level]);
    }
    for (const [variantId, levels] of levelsByVariant) {
      const units = levels.reduce((total, level) => total + (level.locationId === homeLocation.id ? 0 : level.onHand), 0);
      if (units === 0) continue;
      const breakdown = [...levels]
        .sort((a, b) => (order.get(a.locationId) ?? Infinity) - (order.get(b.locationId) ?? Infinity))
        .map((level) => t("stockAtLocation", { location: locationName.get(level.locationId) ?? t("otherLocation"), count: level.onHand }))
        .join(" · ");
      const places = levels
        .filter((level) => level.locationId !== homeLocation.id)
        .map((level) => locationName.get(level.locationId) ?? t("otherLocation"))
        .join(", ");
      byVariant.set(variantId, { units, breakdown, places });
    }
    return byVariant;
    // `t` only words the breakdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeLocation, locations, productLevels]);
  const quantityLabel = homeLocation ? t("quantityAt", { location: homeLocation.name }) : undefined;
  const elsewhereOf = React.useCallback((variantId: string | undefined) => (variantId ? stockElsewhere.get(variantId)?.units ?? 0 : 0), [stockElsewhere]);
  const valueLabel = new Map(options.flatMap((option) => option.values.map((value) => [value.id, value.value] as const)));
  const nameOf = (variant: DraftVariant) => variant.selectedOptionValueIds.map((id) => valueLabel.get(id)).join(" / ");

  const combinationCount = options.length
    ? options.reduce((total, option) => total * option.values.length, 1)
    : 0;
  const validShape = options.length > 0 && options.every((option) => option.name.trim() && option.values.length > 0);
  const matrixIssue = getOptionMatrixIssue(options, shownVariants, images, combinationsPending, {
    committedByVariantId,
    requiredStockAllocation,
    allocationScope: simpleConversion ? "all" : "new",
    blockedCommittedStock,
    allowSavedImageRemovalConfirmation: !dirty,
    requirePositivePrice,
    weightUnit,
  });
  // A product without options sells one hidden SKU; edit its inventory directly.
  const simpleMode = options.length === 0 && savedOptions.length === 0 && (!productId || Boolean(defaultSku));
  const simpleCommitted = defaultSku?.reservedStock ?? 0;
  // The fields edit the default location: they can't go below zero there, and a simple
  // product's units at other locations can't be split into options (the server refuses).
  const simpleElsewhere = elsewhereOf(defaultSku?.id);
  // Every variant tracks a quantity and none has any: buyers see the product as Sold out.
  const soldOutEverywhere = options.length > 0 && shownVariants.length > 0
    && shownVariants.every((variant) => variant.trackInventory && !isDigitalSku(kindRules, variant) && variant.stock === 0);
  const locationIssue: DraftIssue | null = !homeLocation ? null
    : simpleMode
      ? shownSimpleSku.trackInventory && shownSimpleSku.stock - simpleElsewhere < 0
        ? { message: t("issueQuantityWhole"), field: "stock" }
        : null
      : simpleConversion && simpleElsewhere > 0
        ? {
            message: t("issueStockElsewhere", {
              count: simpleElsewhere,
              locations: stockElsewhere.get(defaultSku!.id)!.places,
              home: homeLocation.name,
            }),
          }
        : (() => {
            const below = shownVariants.find((variant) => variant.trackInventory && variant.stock - elsewhereOf(variant.id) < 0);
            return below ? { message: t("issueQuantityWhole"), variantId: below.id, field: "stock" as const } : null;
          })();
  // Cost per item: kept by the page's store (not this draft) and saved right after it.
  // A product without options edits its hidden SKU's cost in the Pricing card.
  const costs = useSkuCosts();
  const costsShown = costs !== null && !kindRules.giftCard;
  const simpleCostKey = costs?.simpleKey ?? "";
  const costRows = React.useMemo<SkuCostRow[]>(() => {
    if (!costsShown) return [];
    return simpleMode
      ? [{ key: simpleCostKey, sku: simpleSku.sku, isDefault: true }]
      : shownVariants.map((variant) => ({ key: variant.id, sku: variant.sku, isDefault: false }));
  }, [costsShown, shownVariants, simpleCostKey, simpleMode, simpleSku.sku]);
  usePublishSkuCostRows(costs, costRows);
  const costKeys = costRows.map((row) => row.key);
  const costsDirty = !readOnly && (costs?.isDirty(costKeys) ?? false);
  const retainedCostKeys = optionDraft.length === 0 ? [simpleCostKey] : variantDraft.map((variant) => variant.id);
  const navigationCostsDirty = costs?.isDirty(retainedCostKeys) ?? false;
  const costTrouble = readOnly ? null : costs?.problemOf(costKeys) ?? null;
  const costIssue: DraftIssue | null = costTrouble
    ? { message: costTrouble.message, field: "cost", ...(simpleMode ? {} : { variantId: costTrouble.key }) }
    : null;
  const variantCosts = React.useMemo<VariantCosts | null>(
    () => (costs ? { of: (id) => costs.costOf(id, readOnly), change: (ids, cost) => { if (!readOnly) costs.setCosts(ids, cost); } } : null),
    [costs, readOnly],
  );

  const draftIssue = locationIssue ?? (!simpleMode
    ? matrixIssue
    : dirty || !productId ? getSimpleSkuIssue(shownSimpleSku, simpleCommitted, Boolean(productId), weightUnit) : null) ?? costIssue;
  const lineFor = (issue: DraftIssue) => {
    const variant = issue.variantId ? variants.find((row) => row.id === issue.variantId) : undefined;
    if (variant) return `${nameOf(variant)}: ${issue.message}`;
    if (simpleMode && issue.field) return `${t(issue.field === "cost" ? "costPerItem" : "inventory")}: ${issue.message}`;
    return issue.message;
  };
  const draftLine = draftIssue ? lineFor(draftIssue) : null;
  // Problems show at their field once the merchant changed something, or after Save was refused.
  const shownIssue = readOnly ? null : serverIssue ?? (dirty || costsDirty || revealed ? draftIssue : null);
  const issueFor: IssueFor = (variantId, field) =>
    shownIssue && shownIssue.field === field && shownIssue.variantId === variantId ? shownIssue.message : undefined;

  React.useEffect(() => {
    if (!onDraftChange) return;
    if (readOnly) { onDraftChange(null); return; }
    const sku = shownSimpleSku.sku.trim();
    onDraftChange(draftIssue
      ? null
      : simpleMode
        ? {
            defaultSku: {
              ...(sku ? { sku } : {}),
              trackInventory: shownSimpleSku.trackInventory,
              stock: shownSimpleSku.trackInventory ? shownSimpleSku.stock : 0,
              ...(shownSimpleSku.barcode ? { barcode: shownSimpleSku.barcode, barcodeType: shownSimpleSku.barcodeType } : {}),
              ...(kindRules.showWeight && shownSimpleSku.weight !== null ? { weight: shownSimpleSku.weight } : {}),
            },
          }
        : options.length > 0 ? { optionMatrix: { options, variants: withFulfilmentMode(shownVariants, fulfilmentMode) } } : null);
  }, [readOnly, draftIssue, fulfilmentMode, kindRules, onDraftChange, options, simpleMode, shownSimpleSku, shownVariants]);

  React.useEffect(() => onDraftIssueChange?.(readOnly ? null : draftLine), [readOnly, draftLine, onDraftIssueChange]);
  // Typed costs count as a variant change: the page's Save sends them after the variants.
  React.useEffect(() => onDirtyChange?.(!readOnly && (dirty || costsDirty)), [readOnly, costsDirty, dirty, onDirtyChange]);
  React.useEffect(() => onNavigationDirtyChange?.(dirty || navigationCostsDirty), [navigationCostsDirty, dirty, onNavigationDirtyChange]);
  const prices = options.length > 0 ? variants.map((variant) => variant.price).filter(Number.isFinite) : [];
  const minPrice = prices.length > 0 ? Math.min(...prices) : null;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
  React.useEffect(
    () => onPricesChange?.(minPrice === null || maxPrice === null ? null : { min: minPrice, max: maxPrice }),
    [minPrice, maxPrice, onPricesChange],
  );

  const reveal = React.useCallback(() => {
    setRevealed(true);
    setRevealNonce((value) => value + 1);
    const target = serverIssue ?? draftIssue;
    if (target?.variantId && target.field && ADVANCED_FIELDS.has(target.field)) setExpandedId(target.variantId);
  }, [draftIssue, serverIssue]);

  // Removing saved variants that still hold stock is confirmed first, naming them.
  const [pendingRemoval, setPendingRemoval] = React.useState<{ title: string; stocked: DraftVariant[]; apply: () => void } | null>(null);
  React.useEffect(() => { if (readOnly) setPendingRemoval(null); }, [readOnly]);
  const confirmRemoval = (title: string, removed: DraftVariant[], apply: () => void) => {
    const stocked = removed.filter((variant) => !variant.id.startsWith("draft_") && variant.trackInventory && variant.stock > 0);
    if (stocked.length === 0) apply();
    else setPendingRemoval({ title, stocked, apply });
  };

  const stageOptions = React.useCallback((nextOptions: DraftOption[]) => {
    setOptions(nextOptions);
    setCombinationsPending(true);
  }, []);

  const applyOptions = React.useCallback(() => {
    if (!validShape || combinationCount > MAX_COMBINATIONS) return;
    const next = materializeVariantsExcluding(
      options,
      variants,
      productName,
      productPrice,
      simpleConversion ? defaultSku!.stock : 0,
      excludedCombinationKeys,
    );
    setVariants(next);
    setExcludedCombinationKeys(new Set(missingOptionCombinations(options, next).map(combinationKey)));
    setTopologyChanged(optionTopologySignature(options) !== savedTopology);
    setCombinationsPending(false);
  }, [combinationCount, defaultSku, excludedCombinationKeys, options, productName, productPrice, savedTopology, simpleConversion, validShape, variants]);

  // Variants follow the options as soon as every option has a name and a value.
  // Existing rows are matched by option values and keep their data; rows that
  // drop out are retired on save, never deleted.
  React.useEffect(() => {
    if (!readOnly && combinationsPending && validShape && combinationCount <= MAX_COMBINATIONS) applyOptions();
  }, [readOnly, applyOptions, combinationCount, combinationsPending, validShape]);

  // Unsaved variants' SKUs follow the title until the merchant edits them. Their prices
  // do not follow the product price: with variants it is derived from them (the cheapest),
  // so following it would copy one row's typing into the others.
  const followedName = React.useRef(productName);
  React.useEffect(() => {
    if (readOnly) return;
    const previousName = followedName.current;
    if (previousName === productName) return;
    followedName.current = productName;
    setVariants((current) => followProductDefaults(options, current, previousName, productName));
  }, [readOnly, options, productName]);

  // One pass for one row or many (bulk and group edits); untouched rows keep their identity,
  // so only the edited rows of the table re-render.
  const updateVariants = React.useCallback((
    ids: ReadonlySet<string>,
    patch: Partial<DraftVariant> | ((variant: DraftVariant) => Partial<DraftVariant>),
  ) => {
    setVariants((current) => current.map((variant) => ids.has(variant.id)
      ? { ...variant, ...(typeof patch === "function" ? patch(variant) : patch) }
      : variant));
    setServerIssue((current) => (current?.variantId && ids.has(current.variantId) ? null : current));
  }, []);
  // The page rebuilds the photo list on every render; keep one identity while it is the same.
  const imagesKey = images.map((image) => `${image.id}:${image.url}:${image.status}:${image.altText}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableImages = React.useMemo(() => images, [imagesKey]);

  const updateSimple = (patch: Partial<SimpleSkuDraft>) => {
    setSimpleSku((current) => ({ ...current, ...patch }));
    setServerIssue(null);
  };

  const removeVariants = React.useCallback((ids: ReadonlySet<string>) => {
    if (ids.size === 0 || ids.size >= variants.length) return;
    const removed = variants.filter((variant) => ids.has(variant.id));
    setVariants(variants.filter((variant) => !ids.has(variant.id)));
    setOmittedVariantsByKey((current) => {
      const next = new Map(current);
      removed.forEach((variant) => next.set(combinationKey(variant.selectedOptionValueIds), variant));
      return next;
    });
    setExcludedCombinationKeys((keys) => new Set([
      ...keys,
      ...removed.map((variant) => combinationKey(variant.selectedOptionValueIds)),
    ]));
    setExpandedId((current) => current && ids.has(current) ? null : current);
  }, [variants]);

  const restoreCombination = React.useCallback((selectedOptionValueIds: string[]) => {
    const key = combinationKey(selectedOptionValueIds);
    const restored = omittedVariantsByKey.get(key)
      ?? materializeCombination(options, variants, selectedOptionValueIds, productName, productPrice);
    const next = [...variants, restored];
    const order = new Map(materializeVariants(options, next, productName, productPrice, 0)
      .map((variant, index) => [combinationKey(variant.selectedOptionValueIds), index]));
    setVariants(next.sort((a, b) =>
      (order.get(combinationKey(a.selectedOptionValueIds)) ?? 0)
      - (order.get(combinationKey(b.selectedOptionValueIds)) ?? 0),
    ));
    setExcludedCombinationKeys((keys) => {
      const next = new Set(keys);
      next.delete(key);
      return next;
    });
    setOmittedVariantsByKey((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, [omittedVariantsByKey, options, productName, productPrice, variants]);

  const restoreAllCombinations = React.useCallback(() => {
    const currentCombinationKeys = new Set(missingOptionCombinations(options, variants).map(combinationKey));
    const restorableOriginals = [...omittedVariantsByKey]
      .filter(([key]) => currentCombinationKeys.has(key))
      .map(([, variant]) => variant);
    setVariants(materializeVariants(options, [...variants, ...restorableOriginals], productName, productPrice, 0));
    setExcludedCombinationKeys(new Set());
    setOmittedVariantsByKey(new Map());
  }, [omittedVariantsByKey, options, productName, productPrice, variants]);

  const missingCombinations = React.useMemo(
    () => missingOptionCombinations(options, variants),
    [options, variants],
  );

  // The table shows (and edits) the default location's quantity: the draft keeps
  // each SKU's total, so a save books exactly the edited difference there.
  // One shifted row per draft row while the levels stay the same, so an edit re-renders only its row.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- new levels start a new cache
  const shifted = React.useMemo(() => new WeakMap<DraftVariant, DraftVariant>(), [stockElsewhere]);
  const tableVariants = React.useMemo(() => stockElsewhere.size === 0 ? shownVariants : shownVariants.map((variant) => {
    const units = stockElsewhere.get(variant.id)?.units ?? 0;
    if (units === 0 || !variant.trackInventory) return variant;
    let row = shifted.get(variant);
    if (!row) {
      row = { ...variant, stock: variant.stock - units };
      shifted.set(variant, row);
    }
    return row;
  }), [shifted, shownVariants, stockElsewhere]);
  const changeTableVariants = React.useCallback((
    ids: ReadonlySet<string>,
    patch: Partial<DraftVariant> | ((variant: DraftVariant) => Partial<DraftVariant>),
  ) => {
    if (stockElsewhere.size === 0) return updateVariants(ids, patch);
    updateVariants(ids, (variant) => {
      const units = stockElsewhere.get(variant.id)?.units ?? 0;
      const next = typeof patch === "function" ? patch({ ...variant, stock: variant.stock - units }) : patch;
      return units === 0 || next.stock === undefined || !Number.isFinite(next.stock) ? next : { ...next, stock: next.stock + units };
    });
  }, [stockElsewhere, updateVariants]);

  /** What the draft saves, without a revision: the hidden SKU's edits, or the whole matrix. */
  const compositionBody = (): ProductUpdateComposition => simpleMode && defaultSku
    ? {
        defaultSku: {
          sku: simpleSku.sku.trim(),
          weight: simpleSku.weight,
          trackInventory: shownSimpleSku.trackInventory,
          barcode: simpleSku.barcode,
          barcodeType: simpleSku.barcodeType,
          // Unedited quantity is omitted so a concurrent sale is never overwritten;
          // a digital SKU's quantity is never sent (its keys move it).
          ...(simpleStockEdited && shownSimpleSku.trackInventory && !digitalSimple
            ? { stock: simpleSku.stock, expectedStockVersion: defaultSku.stockVersion }
            : {}),
        },
      }
    : { optionMatrix: { options, variants: matrixSaveVariants(shownVariants, savedVariants, fulfilmentMode) } };

  const mutation = useMutation({
    mutationFn: (revisionOverride?: number) => {
      const body = compositionBody();
      const expectedAggregateRevision = revisionOverride ?? aggregateRevision!;
      return body.defaultSku && defaultSku
        ? apiData(putApiV1AdminProductsByIdVariantsByVariantId({
            path: { id: productId!, variantId: defaultSku.id },
            body: {
              ...body.defaultSku,
              selectedOptionValueIds: [],
              imageId: defaultSku.imageId,
              price: productPrice,
              discountType: "percentage",
              discountPercentage: null,
              discountAmount: null,
              expectedAggregateRevision,
            },
          }))
        : apiData(putApiV1AdminProductsByIdOptionsMatrix({
            path: { id: productId! },
            body: { ...body.optionMatrix!, expectedAggregateRevision },
          }));
    },
    onSuccess: (result) => settle(result.aggregateRevision),
  });

  /** After a save that carried the draft (this editor's own, or the product's): the draft is the saved one. */
  const settle = async (revision: number) => {
    onAggregateRevisionChange?.(revision);
    // Edits made while the save was on its way stay unsaved.
    setSavedDraft(sentDraft.current);
    setRevealed(false);
    setCombinationsPending(false);
    setTopologyChanged(false);
    setOmittedVariantsByKey(new Map());
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.products.list() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.products.byIds() }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.collectionOptions(),
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.products.stats() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() }),
      queryClient.invalidateQueries({ queryKey: inventoryLocationKeys.productLevels(productId!) }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.detail(productId!),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.products.variants(productId!),
      }),
    ]);
    // `onSaved` (the page reloads the variants) runs once the costs are sent too: see `save`.
  };

  /** Costs go after the variants, so new variants have their ids; a refused cost keeps its edit. */
  const finishSave = async (variantsSaved: boolean, sendCosts: boolean) => {
    try {
      if (costs && sendCosts && productId) await costs.save(productId);
    } finally {
      // The page reloads the variants after the costs, so it never shows a cost from before them.
      if (variantsSaved) onSaved?.();
    }
  };

  /** Puts a server rejection on its field; returns the banner line, or null when it names no field. */
  const showServerIssue = React.useCallback((path: string, message: string): string | null => {
    const parts = path.split(".");
    const rowIndex = parts.findIndex((part) => part === "variants");
    const field = SERVER_FIELDS[parts[parts.length - 1]!];
    if (!field) return null;
    if (rowIndex >= 0) {
      const variant = variants[Number(parts[rowIndex + 1])];
      if (!variant) return null;
      setServerIssue({ message, variantId: variant.id, field });
      if (ADVANCED_FIELDS.has(field)) setExpandedId(variant.id);
      setRevealNonce((value) => value + 1);
      return `${nameOf(variant)}: ${message}`;
    }
    setServerIssue({ message, field });
    return `${t("inventory")}: ${message}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variants, t]);

  React.useEffect(() => onSavingChange?.(mutation.isPending), [mutation.isPending, onSavingChange]);
  React.useImperativeHandle(ref, () => ({
    save: async (revisionOverride) => {
      const sendCosts = costs !== null && costsDirty;
      if (readOnly || !productId || (!dirty && !sendCosts) || mutation.isPending) return;
      if (draftIssue) {
        reveal();
        throw new SaveNotCompleted(lineFor(draftIssue));
      }
      if (dirty) {
        try {
          sentDraft.current = draft;
          await mutation.mutateAsync(revisionOverride);
        } catch (error) {
          const conflict = readProductRevisionConflict(error);
          if (conflict) {
            onRevisionConflict?.(conflict);
            throw new SaveNotCompleted(t("changedElsewhere"));
          }
          const issue = readSkuTaken(error) ?? readApiFieldIssues(error)?.[0];
          const line = issue ? showServerIssue(issue.path, issue.message) : null;
          throw new SaveNotCompleted(line ?? getServerFnError(error, t("saveFailed")));
        }
      }
      await finishSave(dirty, sendCosts);
    },
    composition: () => {
      if (readOnly || !productId || !dirty || mutation.isPending) return null;
      if (draftIssue) {
        reveal();
        throw new SaveNotCompleted(lineFor(draftIssue));
      }
      sentDraft.current = draft;
      return compositionBody();
    },
    compositionSaved: async (revision) => {
      // The write carried the typed costs too; the page reloads the variants.
      await settle(revision);
      onSaved?.();
    },
    reveal,
    showServerIssue,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [readOnly, costs, costsDirty, dirty, draft, draftIssue, mutation, onSaved, productId, reveal, showServerIssue]);

  // A product without options edits its one hidden SKU here: drawn into the page's
  // Inventory and Shipping cards (editor-slots.ts), or in place outside the page.
  const simpleInventory = (
    <>
      {/* Untracked kinds (gift cards) have no quantity to track. */}
      {kindRules.showInventory ? (
        <div className="space-y-1">
          {/* A digital SKU's tracking follows its licence keys: no switch to get wrong. */}
          {digitalSimple ? null : readOnly ? <ReadOnlyValue label={t("trackQuantity")} value={t(simpleSku.trackInventory ? "quantityTracked" : "notTracked")} /> : (
          <label className="flex min-h-11 items-center gap-2 text-body md:min-h-0">
            <Checkbox
              checked={simpleSku.trackInventory}
              onCheckedChange={(checked) => updateSimple({ trackInventory: checked === true })}
            />
            {t("trackQuantity")}
          </label>
          )}
          {digitalSimple ? (
            <p className="text-body text-muted-foreground">
              {d(keepsTracking ? "stockPoolKeepsTracking" : "stockUntrackedHelp")}
            </p>
          ) : null}
        </div>
      ) : null}
      {digitalSimple ? (
        <DigitalStockStatus productId={productId} variantId={defaultSku?.id} tracked={shownSimpleSku.trackInventory} />
      ) : null}
      <FieldRow>
        {shownSimpleSku.trackInventory && !digitalSimple ? (
          <Field
            label={quantityLabel ?? t("quantity")}
            // An active product with nothing to sell shows Sold out to buyers: said here, quietly, before it is saved.
            help={requirePositivePrice && simpleSku.stock === 0 ? t("soldOutWhenActive") : undefined}
            error={issueFor(undefined, "stock")}
          >
              <InventoryQuantityInput
                readOnly={readOnly || !canAdjustStock}
                ariaLabel={quantityLabel ?? t("quantity")}
                value={simpleSku.stock - simpleElsewhere}
                committed={simpleCommitted}
                elsewhere={defaultSku ? stockElsewhere.get(defaultSku.id) : undefined}
                incoming={defaultSku ? incomingByVariant.get(defaultSku.id) : undefined}
                onChange={(stock) => {
                  updateSimple({ stock: Number.isFinite(stock) ? stock + simpleElsewhere : stock });
                  setSimpleStockEdited(true);
                }}
              />
          </Field>
        ) : null}
        {readOnly ? <ReadOnlyValue mono label={t("sku")} value={simpleSku.sku} /> : (
        <Field label={t("sku")} error={issueFor(undefined, "sku")}>
            <Input
              value={simpleSku.sku}
              placeholder={productId ? undefined : t("skuAuto")}
              onChange={(event) => updateSimple({ sku: event.target.value })}
            />
        </Field>
        )}
        {readOnly ? <ReadOnlyValue mono label={t("barcode")} value={simpleSku.barcode} /> : (
        <Field label={t("barcode")} help={productId ? undefined : t("barcodeHint")} error={issueFor(undefined, "barcode")}>
            <Input
              value={simpleSku.barcode ?? ""}
              inputMode="text"
              autoComplete="off"
              onChange={(event) => updateSimple(barcodePatch(event.target.value))}
            />
        </Field>
        )}
      </FieldRow>
    </>
  );
  // Only what is packed is weighed (never a download, a service or a gift card).
  const simpleWeight = kindRules.showWeight ? (
    <FieldRow>
      {readOnly ? <ReadOnlyValue label={t("weightGrams")} value={simpleSku.weight === null ? null : formatWeight(simpleSku.weight, weightUnit)} /> : (
      <Field label={t("weightGrams")} error={issueFor(undefined, "weight")}>
          <WeightInput
            grams={simpleSku.weight}
            onGramsChange={(weight) => updateSimple({ weight })}
          />
      </Field>
      )}
    </FieldRow>
  ) : null;

  return (
    <section data-option-matrix data-variant-editor tabIndex={-1} className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
      {simpleMode && slots?.inventory ? createPortal(
        // The product page's Inventory card (after Pricing), as in Shopify.
        <Card id="product-inventory" className="scroll-mt-4">
          <CardHeader>
            <CardTitle>{t("inventory")}</CardTitle>
          </CardHeader>
          <CardContent data-variant-editor className="space-y-3">{simpleInventory}</CardContent>
        </Card>,
        slots.inventory,
      ) : null}
      {simpleMode && slots?.shipping && simpleWeight ? createPortal(simpleWeight, slots.shipping) : null}
      {simpleMode && !slots?.inventory ? (
        <div className="space-y-3">
          <h3 className="text-body font-medium">{t("inventory")}</h3>
          {simpleInventory}
          {simpleWeight}
        </div>
      ) : null}

      <div>
        {options.length ? (
          <div className="divide-y border-b">
            {options.map((option, optionIndex) => (
              <OptionRow
                readOnly={readOnly}
                key={option.id}
                option={option}
                index={optionIndex}
                canMoveUp={optionIndex > 0}
                canMoveDown={optionIndex < options.length - 1}
                onMove={(direction) => {
                  const next = [...options];
                  const target = optionIndex + direction;
                  [next[optionIndex], next[target]] = [next[target]!, next[optionIndex]!];
                  stageOptions(next);
                }}
                onChange={(next) => stageOptions(options.map((item) =>
                  item.id === option.id ? withGuessedOptionType(item, next, options) : item))}
                onRemove={() => stageOptions(options.filter((item) => item.id !== option.id))}
                onRemoveValue={(value) => confirmRemoval(
                  t("removeValueTitle", { value: value.value }),
                  variants.filter((variant) => variant.selectedOptionValueIds.includes(value.id)),
                  () => stageOptions(options.map((item) =>
                    item.id === option.id ? { ...item, values: item.values.filter((entry) => entry.id !== value.id) } : item)),
                )}
              />
            ))}
          </div>
        ) : null}
        {!readOnly ? <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3 text-body">
          {options.length < MAX_AXES ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => stageOptions([...options, {
                id: draftId("option"),
                name: "",
                standardMapping: "none",
                values: [],
              }])}
            >
              <Plus className="me-1 h-3.5 w-3.5" /> {t(options.length ? "addAnotherOption" : "addOptions")}
            </Button>
          ) : null}
          {/* Limits show as the merchant nears them (from three quarters), never only at save. */}
          {validShape && combinationCount > MAX_COMBINATIONS * 0.75 ? (
            <span className={cn("tabular-nums", combinationCount > MAX_COMBINATIONS ? "text-destructive" : "text-muted-foreground")}>
              {t("variantsLimitNear", { count: combinationCount, max: formatNumber(MAX_COMBINATIONS) })}
            </span>
          ) : null}
          {options.length >= MAX_AXES ? (
            <span className="text-muted-foreground">{t("optionsAtLimit", { max: formatNumber(MAX_AXES) })}</span>
          ) : null}
        </div> : null}
      </div>

      {/* Stock that must be split across the rows: the rule shows before the first quantity is typed. */}
      {!readOnly && requiredStockAllocation > 0 && variants.length > 0 ? (
        <p className="text-body text-muted-foreground" data-allocation-note>
          {t(simpleConversion ? "allocationNote" : "allocationReplaceNote", {
            required: requiredStockAllocation,
            allocated: allocatedStock(shownVariants, simpleConversion ? "all" : "new"),
          })}
        </p>
      ) : null}
      {/* Option-level problems show once a value is entered (an option still being filled in waits
          for Save); variant problems sit on their field. */}
      {shownIssue && !shownIssue.field && !simpleMode && (!shownIssue.incomplete || revealed)
        && options.some((option) => option.values.length > 0) ? (
        <p className="text-body text-destructive" role="alert">
          {lineFor(shownIssue)}
        </p>
      ) : null}
      {requirePositivePrice && soldOutEverywhere ? (
        <p className="text-body text-muted-foreground" data-sold-out-note>{t("soldOutWhenActiveVariants")}</p>
      ) : null}
      {variants.length ? (
        <VariantTable
          readOnly={readOnly}
          options={options}
          variants={tableVariants}
          images={stableImages}
          productName={productName}
          nameOf={nameOf}
          issue={shownIssue}
          reveal={shownIssue?.variantId ? { variantId: shownIssue.variantId, nonce: revealNonce } : null}
          expandedId={expandedId}
          onExpandedChange={setExpandedId}
          onChangeMany={changeTableVariants}
          onRemove={(ids) => confirmRemoval(
            t("stopSellingTitle", { count: ids.size }),
            variants.filter((variant) => ids.has(variant.id)),
            () => removeVariants(ids),
          )}
          missingCombinations={missingCombinations}
          onRestoreCombination={restoreCombination}
          onRestoreAll={restoreAllCombinations}
          committedByVariantId={committedByVariantId}
          printingDisabled={!productId || dirty}
          fulfilmentColumn={fulfilmentMode === "mixed"}
          quantityLabel={quantityLabel}
          stockElsewhere={stockElsewhere}
          incoming={incomingByVariant}
          costs={costsShown ? variantCosts : null}
          productId={productId}
        />
      ) : options.length > 0 && !combinationsPending ? (
        <p className="text-body text-muted-foreground">{t("addOptionValues")}</p>
      ) : null}
      <ConfirmDialog
        open={!readOnly && pendingRemoval !== null}
        onOpenChange={(open) => { if (!open) setPendingRemoval(null); }}
        title={pendingRemoval?.title ?? ""}
        description={pendingRemoval ? t("removeStockedBody", {
          variants: pendingRemoval.stocked.map((variant) => `${nameOf(variant)} (${formatNumber(variant.stock)})`).join(", "),
          count: formatNumber(pendingRemoval.stocked.reduce((total, variant) => total + variant.stock, 0)),
        }) : ""}
        confirmLabel={t("removeAnyway")}
        cancelLabel={t("keepThem")}
        onConfirm={() => {
          if (!readOnly) pendingRemoval?.apply();
          setPendingRemoval(null);
        }}
      />
    </section>
  );
});

OptionMatrixEditor.displayName = "OptionMatrixEditor";

function OptionRow({ readOnly, option, index, canMoveUp, canMoveDown, onMove, onChange, onRemove, onRemoveValue }: {
  readOnly: boolean;
  option: DraftOption;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onChange: (option: DraftOption) => void;
  onRemove: () => void;
  onRemoveValue: (value: DraftOption["values"][number]) => void;
}) {
  const t = useMessages(productVariantMessages);
  const [valueInput, setValueInput] = React.useState("");
  const [duplicate, setDuplicate] = React.useState<string | null>(null);
  const optionLabel = option.name.trim() || t("optionNumber", { number: index + 1 });
  const composerId = React.useId();
  const addValues = () => {
    const existing = new Set(option.values.map((value) => normalized(value.value)));
    const repeated: string[] = [];
    const nextValues = valueInput.split(/[,\n]/).map((value) => value.trim()).filter(Boolean)
      .flatMap((value) => {
        const identity = normalized(value);
        if (existing.has(identity)) {
          repeated.push(option.values.find((entry) => normalized(entry.value) === identity)?.value ?? value);
          return [];
        }
        existing.add(identity);
        return [{ id: draftId("value"), value }];
      });
    // A value already in the option stays in the box with a reason, never silently dropped.
    setDuplicate(repeated[0] ?? null);
    if (nextValues.length) onChange({ ...option, values: [...option.values, ...nextValues] });
    setValueInput(repeated.join(", "));
  };

  if (readOnly) {
    const mapping = { none: "optionTypeOther", size: "optionTypeSize", color: "optionTypeColor", material: "optionTypeMaterial", pattern: "optionTypePattern" } as const;
    return (
      <div className="min-w-0 space-y-3 py-3">
        <FieldRow>
          <ReadOnlyValue label={t("optionNameLabel")} value={optionLabel} />
          <ReadOnlyValue label={t("optionFilterAs")} value={t(mapping[option.standardMapping])} />
        </FieldRow>
        <ReadOnlyValue label={t("optionValuesLabel")} value={option.values.length ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">{option.values.map((value) => <li key={value.id} className="min-w-0">{value.value}</li>)}</ul>
        ) : null} />
      </div>
    );
  }

  // Shopify's option editor: the name (with how customers filter it) on one line, its values below.
  return (
    <div className="space-y-3 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-body text-muted-foreground">
          {t("optionNameLabel")}
          <Input
            value={option.name}
            onChange={(event) => onChange({ ...option, name: event.target.value })}
            placeholder={t("optionNamePlaceholder")}
            aria-label={t("optionName", { number: index + 1 })}
          />
        </label>
        <label className="flex w-full flex-col gap-1 text-body text-muted-foreground sm:w-40">
          {t("optionFilterAs")}
          <SearchableSelect
            value={option.standardMapping}
            onValueChange={(value) => onChange({ ...option, standardMapping: value as ProductOptionStandardMapping })}
            ariaLabel={t("optionType", { name: optionLabel })}
            triggerClassName="w-full"
            options={[
              { value: "none", label: t("optionTypeOther") },
              { value: "size", label: t("optionTypeSize") },
              { value: "color", label: t("optionTypeColor") },
              { value: "material", label: t("optionTypeMaterial") },
              { value: "pattern", label: t("optionTypePattern") },
            ]}
          />
        </label>
        <div className="ms-auto flex shrink-0 items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon" disabled={!canMoveUp} onClick={() => onMove(-1)} aria-label={t("moveOptionUp")} title={t("moveOptionUp")}>
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" disabled={!canMoveDown} onClick={() => onMove(1)} aria-label={t("moveOptionDown")} title={t("moveOptionDown")}>
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={onRemove} aria-label={t("removeOption")} title={t("removeOption")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <span className="block text-body text-muted-foreground">{t("optionValuesLabel")}</span>
        {option.values.length ? (
          <div className="flex flex-wrap gap-1">
            {option.values.map((value) => (
              <Badge key={value.id} variant="secondary">
                {value.value}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("removeValue", { value: value.value })}
                  onClick={() => onRemoveValue(value)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </Badge>
            ))}
          </div>
        ) : null}
        <Input
          data-option-value-composer
          value={valueInput}
          aria-invalid={Boolean(duplicate)}
          aria-describedby={duplicate ? `${composerId}-duplicate` : undefined}
          onChange={(event) => {
            setValueInput(event.target.value);
            setDuplicate(null);
          }}
          onBlur={addValues}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addValues();
            }
          }}
          placeholder={t(option.values.length ? "addValue" : "addValuesHint")}
          aria-label={t("addValueFor", { name: optionLabel })}
        />
        {duplicate ? (
          <p id={`${composerId}-duplicate`} className="text-body text-destructive">{t("valueDuplicate", { value: duplicate })}</p>
        ) : null}
      </div>
    </div>
  );
}

