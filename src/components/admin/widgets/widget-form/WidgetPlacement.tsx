
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Controller } from 'react-hook-form';
import { WidgetPlacementRule, type Collection } from '@/db/schema';

interface WidgetPlacementProps {
  control: any;
  errors: any;
  watch: any;
  register: any;
  availableCollections: Pick<Collection, "id" | "name" | "type">[];
  placementRules: WidgetPlacementRule[];
}

const placementRuleLabels: Record<WidgetPlacementRule, string> = {
  [WidgetPlacementRule.BEFORE_COLLECTION]: "Before Collection",
  [WidgetPlacementRule.AFTER_COLLECTION]: "After Collection",
  [WidgetPlacementRule.FIXED_TOP_HOMEPAGE]: "Fixed: Top of Homepage",
  [WidgetPlacementRule.FIXED_BOTTOM_HOMEPAGE]: "Fixed: Bottom of Homepage",
  [WidgetPlacementRule.STANDALONE]: "Standalone (Shortcode Only)",
};

export const WidgetPlacement: React.FC<WidgetPlacementProps> = ({ control, errors, watch, register, availableCollections, placementRules }) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Placement & Status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="placementRule">Placement Rule</Label>
            <Controller
              name="placementRule"
              control={control}
              render={({ field }) => (
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <SelectTrigger id="placementRule">
                    <SelectValue placeholder="Select placement rule" />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl bg-background">
                    {placementRules.map((rule) => (
                      <SelectItem key={rule} value={rule}>
                        {placementRuleLabels[rule] || rule}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.placementRule && (
              <p className="text-sm text-destructive">
                {errors.placementRule.message}
              </p>
            )}
          </div>
          {(watch("placementRule") ===
            WidgetPlacementRule.BEFORE_COLLECTION ||
            watch("placementRule") ===
              WidgetPlacementRule.AFTER_COLLECTION) && (
            <div className="space-y-2">
              <Label htmlFor="referenceCollectionId">
                Reference Collection
              </Label>
              <Controller
                name="referenceCollectionId"
                control={control}
                render={({ field }) => (
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value || undefined}
                  >
                    <SelectTrigger id="referenceCollectionId">
                      <SelectValue placeholder="Select a collection" />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl bg-background">
                      {availableCollections.map((collection) => (
                        <SelectItem
                          key={collection.id}
                          value={collection.id}
                        >
                          {collection.name} ({collection.type})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.referenceCollectionId && (
                <p className="text-sm text-destructive">
                  {errors.referenceCollectionId.message}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
          <div className="space-y-2">
            <Label htmlFor="sortOrder">Sort Order</Label>
            <Input
              id="sortOrder"
              type="number"
              {...register("sortOrder")}
              placeholder="0"
            />
            <p className="text-xs text-muted-foreground">
              Order among widgets with the same placement. Lower numbers
              appear first.
            </p>
            {errors.sortOrder && (
              <p className="text-sm text-destructive">
                {errors.sortOrder.message}
              </p>
            )}
          </div>
          <div className="flex items-center space-x-2 pt-8">
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
        </div>
      </CardContent>
    </Card>
  );
};
