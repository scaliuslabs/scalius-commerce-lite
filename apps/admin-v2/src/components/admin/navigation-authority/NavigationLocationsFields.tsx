import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { InlineHelp } from "~/components/admin/shell";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Skeleton } from "~/components/ui/skeleton";
import { getServerFnError } from "~/lib/api-helpers";
import {
  getNavigationPlacementSettings,
  saveNavigationPlacementAuthority,
  type NavigationMenuSummary,
  type NavigationPlacementSetting,
} from "~/lib/api-functions/navigation-authority";
import { queryKeys } from "~/lib/query-keys";

import {
  NAVIGATION_LOCATION_SLOTS,
  buildPlacementWrite,
  findPlacementForSlot,
  locationSlotKey,
  menuIdInSlot,
} from "./navigation-authority-model";

export interface NavigationLocationsFieldsProps {
  menu: NavigationMenuSummary;
  /** Names of the other menus, so a taken slot can say what it currently shows. */
  menusById: ReadonlyMap<string, string>;
  onChanged?: () => void;
}

/**
 * "Where this menu appears": one checkbox per storefront slot. Checking a slot
 * that another menu owns hands the slot over, and unchecking switches the slot
 * off rather than deleting the row, which is what the placement API models.
 *
 * Only a published menu can be assigned: an unpublished menu has no live
 * revision for the storefront to render.
 */
export function NavigationLocationsFields({
  menu,
  menusById,
  onChanged,
}: NavigationLocationsFieldsProps) {
  const fieldId = useId();
  const queryClient = useQueryClient();
  const placementsQuery = useQuery({
    queryKey: queryKeys.navigation.placements(),
    queryFn: () => getNavigationPlacementSettings(),
  });
  const placements: NavigationPlacementSetting[] = placementsQuery.data?.placements ?? [];
  const canAssign = menu.publishedRevision != null;

  const mutation = useMutation({
    mutationFn: async (input: {
      slot: (typeof NAVIGATION_LOCATION_SLOTS)[number];
      checked: boolean;
    }) => {
      const placement = findPlacementForSlot(placements, input.slot);
      const write = buildPlacementWrite(input.slot, placement, input.checked ? menu.id : null);
      if (!write) return null;
      return saveNavigationPlacementAuthority({ data: write });
    },
    onSuccess: (_result, input) => {
      toast.success(
        input.checked
          ? `${menu.name} now shows in ${input.slot.label}`
          : `${input.slot.label} no longer shows a menu`,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.placements() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() });
      onChanged?.();
    },
    onError: (error) =>
      toast.error("Storefront location was not updated", {
        description: getServerFnError(error, "Storefront location was not updated"),
      }),
  });

  if (placementsQuery.isLoading) {
    return (
      <div className="space-y-3" role="status" aria-busy="true">
        <span className="sr-only">Loading storefront locations</span>
        {NAVIGATION_LOCATION_SLOTS.map((slot) => (
          <Skeleton key={locationSlotKey(slot)} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  if (placementsQuery.isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive">
        <span>Storefront locations could not be loaded.</span>
        <Button size="sm" variant="outline" onClick={() => void placementsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="navigation-locations">
      {!canAssign ? (
        <InlineHelp>Publish this menu before assigning it to a storefront location.</InlineHelp>
      ) : null}
      {NAVIGATION_LOCATION_SLOTS.map((slot) => {
        const key = locationSlotKey(slot);
        const occupantId = menuIdInSlot(placements, slot);
        const checked = occupantId === menu.id;
        const occupantName = occupantId && occupantId !== menu.id
          ? menusById.get(occupantId)
          : undefined;
        const inputId = `${fieldId}-${key}`;
        return (
          <div key={key} className="flex min-h-11 items-start gap-3 py-1 sm:min-h-9">
            <Checkbox
              id={inputId}
              checked={checked}
              disabled={!canAssign || mutation.isPending}
              aria-describedby={`${inputId}-help`}
              className="mt-1 size-5 sm:size-4"
              onCheckedChange={(value) =>
                mutation.mutate({ slot, checked: value === true })}
            />
            <div className="min-w-0 flex-1">
              <label
                htmlFor={inputId}
                className="block cursor-pointer py-1 text-sm font-medium leading-5 sm:py-0"
              >
                {slot.label}
              </label>
              <InlineHelp id={`${inputId}-help`}>
                {occupantName
                  ? `${slot.description}. Now showing ${occupantName}.`
                  : slot.description}
              </InlineHelp>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default NavigationLocationsFields;
