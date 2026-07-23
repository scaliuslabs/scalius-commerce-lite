import { Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  ProviderIcon,
  PROVIDER_VISUAL,
  getProviderReadinessBadgeClass,
  getProviderReadinessLabel,
  resolveProviderReadiness,
  type DeliveryProviderRecord,
} from "./ProviderIcon";

interface ProviderListSidebarProps {
  providers: DeliveryProviderRecord[];
  selectedProviderId: string | null;
  onSelect: (provider: DeliveryProviderRecord) => void;
  onCreate: () => void;
  selectionDisabled: boolean;
}

export function ProviderListSidebar({
  providers,
  selectedProviderId,
  onSelect,
  onCreate,
  selectionDisabled,
}: ProviderListSidebarProps) {
  return (
    <div className="md:col-span-1 space-y-4">
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Providers</CardTitle>
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={onCreate}
            disabled={selectionDisabled}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {providers.length === 0 ? (
            <div className="px-6 pb-6 text-sm text-muted-foreground">
              No providers configured yet.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {providers.map((provider) => {
                const readiness = resolveProviderReadiness(provider);
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => onSelect(provider)}
                    disabled={selectionDisabled}
                    aria-current={selectedProviderId === provider.id ? "true" : undefined}
                    className={`min-h-16 w-full px-4 py-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60 ${selectedProviderId === provider.id
                      ? "bg-muted/60 border-l-2 border-l-primary"
                      : "border-l-2 border-l-transparent"
                      }`}
                  >
                    <div className="flex items-center gap-3">
                      <ProviderIcon type={provider.type} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-sm truncate">
                            {provider.name}
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 flex-shrink-0 ${getProviderReadinessBadgeClass(readiness)}`}
                          >
                            {getProviderReadinessLabel(readiness)}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 font-normal capitalize ${PROVIDER_VISUAL[provider.type]?.badgeClass || ""}`}
                          >
                            {provider.type}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
