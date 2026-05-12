
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Controller, useFieldArray } from 'react-hook-form';
import type { Control, UseFormRegister, UseFormSetValue, UseFormWatch, FieldErrors } from 'react-hook-form';
import { Check, ChevronsUpDown, Plus, Trash2 } from 'lucide-react';
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
} from '@/types/api-responses';
import type { WidgetFormValues } from '@/lib/form-schemas';
import { WidgetTargetSelect } from './WidgetTargetSelect';
import { cn } from '@scalius/shared/utils';

interface WidgetPlacementProps {
  control: Control<WidgetFormValues>;
  errors: FieldErrors<WidgetFormValues>;
  watch: UseFormWatch<WidgetFormValues>;
  register: UseFormRegister<WidgetFormValues>;
  setValue: UseFormSetValue<WidgetFormValues>;
}

const scopeLabels: Partial<Record<WidgetPlacementScope, string>> = {
  [WidgetPlacementScope.HOMEPAGE]: "Homepage",
  [WidgetPlacementScope.PAGE]: "Page",
  [WidgetPlacementScope.PRODUCT]: "Product",
  [WidgetPlacementScope.CATEGORY]: "Category",
  [WidgetPlacementScope.COLLECTION]: "Collection",
};

const placementScopes = [
  WidgetPlacementScope.HOMEPAGE,
  WidgetPlacementScope.PAGE,
  WidgetPlacementScope.PRODUCT,
  WidgetPlacementScope.CATEGORY,
  WidgetPlacementScope.COLLECTION,
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

type PlacementOptionSelectProps<TValue extends string> = {
  value: TValue;
  options: readonly TValue[];
  labels: Partial<Record<TValue, string>>;
  onChange: (value: TValue) => void;
};

function PlacementOptionSelect<TValue extends string>({
  value,
  options,
  labels,
  onChange,
}: PlacementOptionSelectProps<TValue>) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-10 w-full justify-between px-3 font-normal"
        >
          <span className="truncate">{labels[value] ?? value}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[--radix-popover-trigger-width] max-h-[--radix-popover-content-available-height] p-0"
      >
        <Command>
          <CommandList>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option}
                  value={labels[option] ?? option}
                  onSelect={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      option === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span>{labels[option] ?? option}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export const WidgetPlacement: React.FC<WidgetPlacementProps> = ({
  control,
  errors,
  watch,
  register,
  setValue,
}) => {
  const { fields, append, remove } = useFieldArray({
    control,
    name: "placements",
    keyName: "fieldKey",
  });
  const placements = watch("placements") ?? [];
  const isWidgetActive = watch("isActive");
  const activePlacementCount = placements.filter((placement) => placement.isActive).length;
  const placementListMessage =
    typeof errors.placements?.message === "string"
      ? errors.placements.message
      : typeof (errors.placements as { root?: { message?: unknown } } | undefined)?.root?.message === "string"
        ? String((errors.placements as { root?: { message?: unknown } }).root?.message)
        : undefined;

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
          <div className="flex items-center gap-2">
            <CardTitle>Placement & Status</CardTitle>
            <Badge variant={isWidgetActive ? "default" : "secondary"}>
              {isWidgetActive ? "Active" : "Draft"}
            </Badge>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addPlacement}>
            <Plus className="mr-2 h-4 w-4" />
            Add placement
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <input type="hidden" {...register("displayTarget")} />
        {placementListMessage && (
          <p className="text-sm text-destructive">{placementListMessage}</p>
        )}

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
          <span className="text-sm text-muted-foreground">
            {activePlacementCount === 0
              ? "Shortcode only"
              : `${activePlacementCount} active placement${activePlacementCount === 1 ? "" : "s"}`}
          </span>
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
                  targetType: "page" as const,
                }
              : scope === WidgetPlacementScope.PRODUCT
                ? {
                    label: "Product",
                    placeholder: "Select product",
                    targetType: "product" as const,
                  }
                : scope === WidgetPlacementScope.CATEGORY
                  ? {
                      label: "Category",
                      placeholder: "Select category",
                      targetType: "category" as const,
                    }
                  : scope === WidgetPlacementScope.COLLECTION
                    ? {
                        label: "Collection",
                        placeholder: "Select collection",
                        targetType: "collection" as const,
                      }
                    : null;
          const placementErrors = errors.placements?.[index];
          const placementMessage =
            typeof placementErrors?.message === "string"
              ? placementErrors.message
              : typeof (placementErrors as { root?: { message?: unknown } } | undefined)?.root?.message === "string"
                ? String((placementErrors as { root?: { message?: unknown } }).root?.message)
                : undefined;

          return (
            <div key={field.fieldKey} className="rounded-md border p-3">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_1fr_1fr_96px_48px]">
                <div className="space-y-2">
                  <Label>Scope</Label>
                  <Controller
                    name={`placements.${index}.scope`}
                    control={control}
                    render={({ field: scopeField }) => (
                      <PlacementOptionSelect
                        value={scopeField.value}
                        options={placementScopes}
                        labels={scopeLabels}
                        onChange={(value) => {
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
                      />
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
                          <WidgetTargetSelect
                            targetType={scopeTarget.targetType}
                            value={scopeTargetField.value ?? undefined}
                            onChange={scopeTargetField.onChange}
                            placeholder={scopeTarget.placeholder}
                            searchPlaceholder={`Search ${scopeTarget.label.toLowerCase()}...`}
                          />
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
                      <PlacementOptionSelect
                        value={slotField.value}
                        options={slotOptions}
                        labels={slotLabels}
                        onChange={(value) => {
                          slotField.onChange(value);
                          if (isWidgetCollectionSlot(value)) {
                            setValue(`placements.${index}.anchorType`, WidgetPlacementAnchorType.COLLECTION, { shouldDirty: true });
                          } else {
                            setValue(`placements.${index}.anchorType`, null, { shouldDirty: true });
                            setValue(`placements.${index}.anchorId`, null, { shouldDirty: true });
                          }
                        }}
                      />
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
                      <WidgetTargetSelect
                        targetType="collection"
                        value={collectionField.value ?? undefined}
                        onChange={(value) => {
                          setValue(`placements.${index}.anchorType`, WidgetPlacementAnchorType.COLLECTION, { shouldDirty: true });
                          collectionField.onChange(value);
                        }}
                        placeholder="Select collection"
                        searchPlaceholder="Search collection..."
                      />
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
              {placementMessage && (
                <p className="mt-2 text-sm text-destructive">{placementMessage}</p>
              )}
            </div>
          );
        })}

        {fields.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {isWidgetActive
              ? "Active shortcode widget. It renders only where its shortcode is embedded."
              : "Draft shortcode widget. Add a placement to render it automatically."}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
