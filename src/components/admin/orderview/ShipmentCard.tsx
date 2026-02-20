import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Truck, ChevronDown, ChevronUp, Loader2, ExternalLink } from "lucide-react";
import type { DeliveryShipment } from "@/db/schema";
import { ShipmentMetadataDisplay } from "@/components/ui/ShipmentMetadataDisplay";
import ShipmentStatusIndicator from "@/components/admin/ShipmentStatusIndicator";
import type { Order } from "./types";

interface ShipmentCardProps {
  order: Order;
}

const CreateShipmentForm = ({
  order,
  onShipmentCreated,
}: {
  order: Order;
  onShipmentCreated: () => void;
}) => {
  const { toast } = useToast();
  const [isCreatingShipment, setIsCreatingShipment] = React.useState(false);
  const [selectedProviderId, setSelectedProviderId] = React.useState("");

  const handleCreateShipment = async () => {
    if (!selectedProviderId) {
      toast({
        title: "Error",
        description: "Please select a delivery provider.",
        variant: "destructive",
      });
      return;
    }
    setIsCreatingShipment(true);
    try {
      const response = await fetch(`/api/orders/${order.id}/shipments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: selectedProviderId, options: {} }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to create shipment");
      }
      toast({
        title: "Success",
        description: "Shipment created successfully. Page will reload.",
      });
      onShipmentCreated();
    } catch (error) {
      toast({
        title: "Error Creating Shipment",
        description:
          error instanceof Error ? error.message : "An unknown error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsCreatingShipment(false);
    }
  };

  return (
    <Card className="mt-6 overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="h-4 w-4" />
          Create Shipment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              Select Delivery Provider
            </label>
            <Select
              value={selectedProviderId}
              onValueChange={setSelectedProviderId}
              disabled={isCreatingShipment}
            >
              <SelectTrigger className="h-9 text-sm border-border bg-background text-foreground">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card text-foreground">
                {order.deliveryProviders?.map((provider) => (
                  <SelectItem
                    key={provider.id}
                    value={provider.id}
                    className="text-foreground"
                  >
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="w-full"
            disabled={isCreatingShipment || !selectedProviderId}
            onClick={handleCreateShipment}
          >
            {isCreatingShipment && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {isCreatingShipment ? "Creating..." : "Create Shipment"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

const ShipmentHistoryItem = ({
  shipment,
  orderId,
  onStatusUpdated,
}: {
  shipment: DeliveryShipment;
  orderId: string;
  onStatusUpdated: () => void;
}) => {
  const [isExpanded, setIsExpanded] = React.useState(false);

  return (
    <div key={shipment.id} className="p-4">
      <div className="flex items-start justify-between">
        <div className="flex flex-col">
          <span className="mb-1 text-xs text-muted-foreground">
            {new Date(shipment.createdAt).toLocaleDateString()}
          </span>
          <ShipmentStatusIndicator
            shipment={{
              id: shipment.id,
              status: shipment.status,
              orderId: orderId,
              lastChecked:
                shipment.lastChecked instanceof Date
                  ? shipment.lastChecked.toISOString()
                  : typeof shipment.lastChecked === "string"
                    ? shipment.lastChecked
                    : undefined,
            }}
            onStatusUpdated={onStatusUpdated}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(!isExpanded)}
          className="h-8 w-8 p-0 text-foreground hover:bg-muted/50 hover:text-primary"
        >
          {isExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="mt-3 space-y-1 border-t border-border pt-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Provider:</span>
          <span className="text-foreground">{shipment.providerType}</span>
        </div>
        {shipment.trackingId && (() => {
          const trackingUrl = shipment.providerType === "pathao"
            ? `https://merchant.pathao.com/tracking?consignment_id=${encodeURIComponent(shipment.trackingId)}`
            : shipment.providerType === "steadfast"
              ? `https://steadfast.com.bd/t/${encodeURIComponent(shipment.trackingId)}`
              : null;

          return (
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Tracking ID:</span>
              <div className="flex flex-col items-end gap-1">
                <span className="font-mono text-xs">{shipment.trackingId}</span>
                {trackingUrl && (
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
                    <a href={trackingUrl} target="_blank" rel="noopener noreferrer">
                      View Courier Tracking <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </Button>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {isExpanded && shipment.metadata && (
        <div className="mt-3 border-t border-border pt-3">
          <h4 className="mb-2 text-sm font-medium text-foreground">
            Detailed Information
          </h4>
          <ShipmentMetadataDisplay metadata={shipment.metadata} />
        </div>
      )}
    </div>
  );
};

export function ShipmentCard({ order }: ShipmentCardProps) {
  const handlePageReload = () => {
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  };

  const hasProviders = order.deliveryProviders && order.deliveryProviders.length > 0;
  const hasShipments = order.shipments && order.shipments.length > 0;

  return (
    <>
      {hasProviders && (
        <CreateShipmentForm order={order} onShipmentCreated={handlePageReload} />
      )}

      {hasShipments && (
        <Card className="mt-6 overflow-hidden">
          <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4" />
              Shipment History
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {order.shipments?.map((shipment) => (
                <ShipmentHistoryItem
                  key={shipment.id}
                  shipment={shipment}
                  orderId={order.id}
                  onStatusUpdated={handlePageReload}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}