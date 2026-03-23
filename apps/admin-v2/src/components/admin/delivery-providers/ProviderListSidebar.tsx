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
  PROVIDER_TYPES,
  type DeliveryProviderRecord,
} from "./ProviderIcon";

interface ProviderListSidebarProps {
  providers: DeliveryProviderRecord[];
  selectedProviderId: string | null;
  onSelect: (provider: DeliveryProviderRecord) => void;
  onCreate: () => void;
}

export function ProviderListSidebar({
  providers,
  selectedProviderId,
  onSelect,
  onCreate,
}: ProviderListSidebarProps) {
  return (
    <div className="md:col-span-1 space-y-4">
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Providers</CardTitle>
          <Button size="sm" onClick={onCreate}>
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
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => onSelect(provider)}
                  className={`w-full text-left px-4 py-3 transition-colors hover:bg-muted/50 ${selectedProviderId === provider.id
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
                          variant={provider.isActive ? "default" : "secondary"}
                          className="text-[10px] px-1.5 py-0 flex-shrink-0"
                        >
                          {provider.isActive ? "Active" : "Inactive"}
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
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Supported Providers */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Supported Providers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 pt-0">
          {PROVIDER_TYPES.map((pt) => {
            const visual = PROVIDER_VISUAL[pt.value];
            return (
              <div key={pt.value} className="flex items-center gap-2.5">
                <ProviderIcon type={pt.value} size="sm" />
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-tight">{pt.label}</p>
                  <p className="text-[11px] text-muted-foreground leading-tight">
                    {visual?.description}
                  </p>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
