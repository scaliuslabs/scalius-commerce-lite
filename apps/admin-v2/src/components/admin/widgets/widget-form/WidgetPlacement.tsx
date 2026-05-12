
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Controller, useFieldArray } from 'react-hook-form';
import type { Control, UseFormRegister, UseFormSetValue, UseFormWatch, FieldErrors } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import {
  CONTENT_WIDGET_PLACEMENT_SLOTS,
  HOMEPAGE_WIDGET_PLACEMENT_SLOTS,
  isWidgetCollectionSlot,
  normalizeWidgetPlacementSlotForScope,
} from '@scalius/shared/widget-placement';
import {
  WidgetPlacementAnchorType,
  WidgetPlacementScope,
  WidgetPlacementSlot,
  type Collection,
} from '@/types/api-responses';
import type { WidgetFormValues } from '@/lib/form-schemas';

interface WidgetPlacementProps {
  control: Control<WidgetFormValues>;
  errors: FieldErrors<WidgetFormValues>;
  watch: UseFormWatch<WidgetFormValues>;
  register: UseFormRegister<WidgetFormValues>;
  setValue: UseFormSetValue<WidgetFormValues>;
  availableCollections: Pick<Collection, "id" | "name" | "type">[];
  availablePages: Array<{ id: string; title: string; slug: string; sortOrder: number }>;
  availableProducts: Array<{ id: string; name: string; slug: string }>;
  availableCategories: Array<{ id: string; name: string; slug: string }>;
}

const scopeLabels: Partial<Record<WidgetPlacementScope, string>> = {
  [WidgetPlacementScope.HOMEPAGE]: "Homepage",
  [WidgetPlacementScope.PAGE]: "Page",
  [WidgetPlacementScope.PRODUCT]: "Product",
  [WidgetPlacementScope.CATEGORY]: "Category",
};

const placementScopes = [
  WidgetPlacementScope.HOMEPAGE,
  WidgetPlacementScope.PAGE,
  WidgetPlacementScope.PRODUCT,
  WidgetPlacementScope.CATEGORY,
] as const;

const slotLabels: Partial<Record<WidgetPlacementSlot, string>> = {
  [WidgetPlacementSlot.TOP]: "Top",
  [WidgetPlacementSlot.BOTTOM]: "Bottom",
  [WidgetPlacementSlot.BEFORE_CONTENT]: "Before content",
  [WidgetPlacementSlot.AFTER_CONTENT]: "After content",
  [WidgetPlacementSlot.BEFORE_COLLECTION]: "Before collection",
  [WidgetPlacementSlot.AFTER_COLLECTION]: "After collection",
};

const homepageSlots = HOMEPAGE_WIDGET_PLACEMENT_SLOTS;
const pageSlots = CONTENT_WIDGET_PLACEMENT_SLOTS;

export const WidgetPlacement: React.FC<WidgetPlacementProps> = ({
  control,
  errors,
  watch,
  register,
  setValue,
  availableCollections,
  availablePages,
  availableProducts,
  availableCategories,
}) => {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "placements",
    keyName: "fieldKey",
  });
  const placements = watch("placements") ?? [];

  const addPlacement = () => {
    append({
      scope: WidgetPlacementScope.HOMEPAGE,
      scopeId: null,
      slot: WidgetPlacementSlot.TOP,
      anchorType: null,
      anchorId: null,
      sortOrder: fields.length,
      isActive: true,
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Placement & Status</CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={addPlacement}>
            <Plus className="mr-2 h-4 w-4" />
            Add placement
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <input type="hidden" {...register("displayTarget")} />

        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="flex items-center gap-3">
            <Controller
              name="isActive"
              control={control}
              render={({ field }) => (
                <Switch
                  id="isActive"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <Label htmlFor="isActive" className="cursor-pointer">
              Active
            </Label>
          </div>
          {fields.length === 0 && (
            <span className="text-sm text-muted-foreground">Shortcode only</span>
          )}
        </div>

        {fields.map((field, index) => {
          const placement = placements[index];
          const scope = placement?.scope ?? WidgetPlacementScope.HOMEPAGE;
          const slot = placement?.slot ?? WidgetPlacementSlot.TOP;
          const slotOptions =
            scope === WidgetPlacementScope.HOMEPAGE ? homepageSlots : pageSlots;
          const requiresScopeTarget = scope !== WidgetPlacementScope.HOMEPAGE;
          const scopeTarget =
            scope === WidgetPlacementScope.PAGE
              ? {
                  label: "Page",
                  placeholder: "Select page",
                  options: availablePages.map((page) => ({
                    id: page.id,
                    label: page.title,
                    description: page.slug,
                  })),
                }
              : scope === WidgetPlacementScope.PRODUCT
                ? {
                    label: "Product",
                    placeholder: "Select product",
                    options: availableProducts.map((product) => ({
                      id: product.id,
                      label: product.name,
                      description: product.slug,
                    })),
                  }
                : scope === WidgetPlacementScope.CATEGORY
                  ? {
                      label: "Category",
                      placeholder: "Select category",
                      options: availableCategories.map((category) => ({
                        id: category.id,
                        label: category.name,
                        description: category.slug,
                      })),
                    }
                  : null;
          const placementErrors = errors.placements?.[index];

          return (
            <div key={field.fieldKey} className="rounded-md border p-3">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr_1fr_96px_48px]">
                <div className="space-y-2">
                  <Label>Scope</Label>
                  <Controller
                    name={`placements.${index}.scope`}
                    control={control}
                    render={({ field: scopeField }) => (
                      <Select
                        value={scopeField.value}
                        onValueChange={(value: WidgetPlacementScope) => {
                          const nextSlot = normalizeWidgetPlacementSlotForScope(
                            value,
                            slot,
                          ) as WidgetPlacementSlot;
                          scopeField.onChange(value);
                          setValue(`placements.${index}.scopeId`, null, { shouldDirty: true });
                          setValue(`placements.${index}.anchorType`, null, { shouldDirty: true });
                          setValue(`placements.${index}.anchorId`, null, { shouldDirty: true });
                          if (nextSlot !== slot) {
                            setValue(`placements.${index}.slot`, nextSlot, { shouldDirty: true });
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="rounded-xl bg-background">
                          {placementScopes.map((value) => (
                            <SelectItem key={value} value={value}>
                              {scopeLabels[value] ?? value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{scopeTarget?.label ?? "Slot"}</Label>
                  {requiresScopeTarget && scopeTarget ? (
                    <>
                      <Controller
                        name={`placements.${index}.scopeId`}
                        control={control}
                        render={({ field: scopeTargetField }) => (
                          <Select
                            value={scopeTargetField.value ?? undefined}
                            onValueChange={scopeTargetField.onChange}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder={scopeTarget.placeholder} />
                            </SelectTrigger>
                            <SelectContent className="rounded-xl bg-background">
                              {scopeTarget.options.map((option) => (
                                <SelectItem key={option.id} value={option.id}>
                                  {option.label} ({option.description})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      />
                      {placementErrors?.scopeId && (
                        <p className="text-sm text-destructive">
                          {placementErrors.scopeId.message}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="flex h-10 items-center rounded-md border px-3 text-sm text-muted-foreground">
                      Storefront
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Position</Label>
                  <Controller
                    name={`placements.${index}.slot`}
                    control={control}
                    render={({ field: slotField }) => (
                      <Select
                        value={slotField.value}
                        onValueChange={(value: WidgetPlacementSlot) => {
                          slotField.onChange(value);
                          if (isWidgetCollectionSlot(value)) {
                            setValue(`placements.${index}.anchorType`, WidgetPlacementAnchorType.COLLECTION, { shouldDirty: true });
                          } else {
                            setValue(`placements.${index}.anchorType`, null, { shouldDirty: true });
                            setValue(`placements.${index}.anchorId`, null, { shouldDirty: true });
                          }
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="rounded-xl bg-background">
                          {slotOptions.map((value) => (
                            <SelectItem key={value} value={value}>
                              {slotLabels[value] ?? value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Order</Label>
                  <Input
                    type="number"
                    {...register(`placements.${index}.sortOrder`)}
                  />
                </div>

                <div className="flex items-end justify-end gap-2">
                  <Controller
                    name={`placements.${index}.isActive`}
                    control={control}
                    render={({ field: activeField }) => (
                      <Switch
                        checked={activeField.value}
                        onCheckedChange={activeField.onChange}
                        aria-label="Placement active"
                      />
                    )}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(index)}
                    aria-label="Remove placement"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {isWidgetCollectionSlot(slot) && (
                <div className="mt-3 max-w-md space-y-2">
                  <Label>Collection</Label>
                  <Controller
                    name={`placements.${index}.anchorId`}
                    control={control}
                    render={({ field: collectionField }) => (
                      <Select
                        value={collectionField.value ?? undefined}
                        onValueChange={(value) => {
                          setValue(`placements.${index}.anchorType`, WidgetPlacementAnchorType.COLLECTION, { shouldDirty: true });
                          collectionField.onChange(value);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select collection" />
                        </SelectTrigger>
                        <SelectContent className="rounded-xl bg-background">
                          {availableCollections.map((collection) => (
                            <SelectItem key={collection.id} value={collection.id}>
                              {collection.name} ({collection.type})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {placementErrors?.anchorId && (
                    <p className="text-sm text-destructive">
                      {placementErrors.anchorId.message}
                    </p>
                  )}
                </div>
              )}

              {placementErrors?.sortOrder && (
                <p className="mt-2 text-sm text-destructive">
                  {placementErrors.sortOrder.message}
                </p>
              )}
            </div>
          );
        })}

        {fields.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This widget will only render where its shortcode is embedded.
          </div>
        )}
      </CardContent>
    </Card>
  );
};
