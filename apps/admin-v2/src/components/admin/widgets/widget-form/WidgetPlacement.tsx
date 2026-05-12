
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
}

const scopeLabels: Partial<Record<WidgetPlacementScope, string>> = {
  [WidgetPlacementScope.HOMEPAGE]: "Homepage",
  [WidgetPlacementScope.PAGE]: "Page",
};

const placementScopes = [
  WidgetPlacementScope.HOMEPAGE,
  WidgetPlacementScope.PAGE,
] as const;

const slotLabels: Partial<Record<WidgetPlacementSlot, string>> = {
  [WidgetPlacementSlot.TOP]: "Top",
  [WidgetPlacementSlot.BOTTOM]: "Bottom",
  [WidgetPlacementSlot.BEFORE_CONTENT]: "Before content",
  [WidgetPlacementSlot.AFTER_CONTENT]: "After content",
  [WidgetPlacementSlot.BEFORE_COLLECTION]: "Before collection",
  [WidgetPlacementSlot.AFTER_COLLECTION]: "After collection",
};

const homepageSlots = [
  WidgetPlacementSlot.TOP,
  WidgetPlacementSlot.BOTTOM,
  WidgetPlacementSlot.BEFORE_COLLECTION,
  WidgetPlacementSlot.AFTER_COLLECTION,
];

const pageSlots = [
  WidgetPlacementSlot.TOP,
  WidgetPlacementSlot.BOTTOM,
  WidgetPlacementSlot.BEFORE_CONTENT,
  WidgetPlacementSlot.AFTER_CONTENT,
];

const isCollectionSlot = (slot: WidgetPlacementSlot | undefined) =>
  slot === WidgetPlacementSlot.BEFORE_COLLECTION ||
  slot === WidgetPlacementSlot.AFTER_COLLECTION;

export const WidgetPlacement: React.FC<WidgetPlacementProps> = ({
  control,
  errors,
  watch,
  register,
  setValue,
  availableCollections,
  availablePages,
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
        <input type="hidden" {...register("placementRule")} />
        <input type="hidden" {...register("referenceCollectionId")} />
        <input type="hidden" {...register("sortOrder")} />

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
            scope === WidgetPlacementScope.PAGE ? pageSlots : homepageSlots;
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
                          scopeField.onChange(value);
                          setValue(`placements.${index}.scopeId`, null, { shouldDirty: true });
                          setValue(`placements.${index}.anchorType`, null, { shouldDirty: true });
                          setValue(`placements.${index}.anchorId`, null, { shouldDirty: true });
                          if (
                            value === WidgetPlacementScope.PAGE &&
                            isCollectionSlot(slot)
                          ) {
                            setValue(`placements.${index}.slot`, WidgetPlacementSlot.BEFORE_CONTENT, { shouldDirty: true });
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
                  <Label>{scope === WidgetPlacementScope.PAGE ? "Page" : "Slot"}</Label>
                  {scope === WidgetPlacementScope.PAGE ? (
                    <>
                      <Controller
                        name={`placements.${index}.scopeId`}
                        control={control}
                        render={({ field: pageField }) => (
                          <Select
                            value={pageField.value ?? undefined}
                            onValueChange={pageField.onChange}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select page" />
                            </SelectTrigger>
                            <SelectContent className="rounded-xl bg-background">
                              {availablePages.map((page) => (
                                <SelectItem key={page.id} value={page.id}>
                                  {page.title}
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
                          if (isCollectionSlot(value)) {
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

              {isCollectionSlot(slot) && (
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
