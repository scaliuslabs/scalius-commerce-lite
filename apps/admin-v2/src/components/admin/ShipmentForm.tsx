import { useState, useEffect, type FC } from "react";
import type { DeliveryProviderRecord } from "@/types/api-responses";
import { toast } from "sonner";
import { getServerFnError } from "@/lib/api-helpers";
import { getDeliveryProviders } from "@/lib/api-functions/delivery";
import {
  createOrderShipment,
  type CreateOrderShipmentPayload,
} from "@/lib/api-functions/orders";
import {
  getProviderReadinessLabel,
  getProviderReadinessMessage,
  resolveProviderReadiness,
} from "@/components/admin/delivery-providers/ProviderIcon";

interface ShipmentFormProps {
  orderId: string;
  onSuccess?: (shipment: CreateOrderShipmentPayload) => void;
  onCancel?: () => void;
}

const ShipmentForm: FC<ShipmentFormProps> = ({
  orderId,
  onSuccess,
  onCancel,
}) => {
  const [providers, setProviders] = useState<DeliveryProviderRecord[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Load active providers on component mount
  useEffect(() => {
    const fetchProviders = async () => {
      setIsLoading(true);
      try {
        const data = await getDeliveryProviders();
        setProviders(data);

        const firstReadyProvider = data.find(
          (p: DeliveryProviderRecord) =>
            resolveProviderReadiness(p).canCreateShipment,
        );
        if (firstReadyProvider) {
          setSelectedProviderId(firstReadyProvider.id);
        }
      } catch (error: unknown) {
        console.error("Error fetching providers:", error);
        toast.error("Failed to load delivery providers");
      } finally {
        setIsLoading(false);
      }
    };

    fetchProviders();
  }, []);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const selectedProvider = providers.find(
      (provider) => provider.id === selectedProviderId,
    );
    const selectedReadiness = selectedProvider
      ? resolveProviderReadiness(selectedProvider)
      : null;

    if (!selectedProviderId) {
      toast.error("Please select a delivery provider");
      return;
    }
    if (!selectedProvider || !selectedReadiness?.canCreateShipment) {
      toast.error(
        getProviderReadinessMessage(
          selectedReadiness ?? {
            canCreateShipment: false,
            blockers: [],
          },
        ),
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const shipment = await createOrderShipment({
        data: { orderId, providerId: selectedProviderId, options: {} },
      });
      toast.success("Shipment created successfully");

      if (onSuccess) {
        onSuccess(shipment);
      }
    } catch (error: unknown) {
      console.error("Error creating shipment:", error);
      toast.error(getServerFnError(error, "Failed to create shipment"));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return <div className="text-center py-4">Loading providers...</div>;
  }

  if (providers.length === 0) {
    return (
      <div className="p-4 border rounded bg-yellow-50 text-yellow-800">
        <h3 className="font-medium">No delivery providers</h3>
        <p className="text-sm mt-1">
          Please set up a delivery provider in settings before creating
          shipments.
        </p>
        <button
          onClick={onCancel}
          className="mt-3 px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  const selectedProvider = providers.find(
    (provider) => provider.id === selectedProviderId,
  );
  const selectedReadiness = selectedProvider
    ? resolveProviderReadiness(selectedProvider)
    : null;
  const selectedBlocker = selectedReadiness &&
    !selectedReadiness.canCreateShipment
      ? getProviderReadinessMessage(selectedReadiness)
      : "";
  const readyProviderCount = providers.filter(
    (provider) => resolveProviderReadiness(provider).canCreateShipment,
  ).length;

  return (
    <div className="border rounded p-4">
      <h3 className="font-medium mb-4">Create Shipment</h3>
      <form method="post" onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label className="block text-sm font-medium mb-1">
            Delivery Provider
          </label>
          <select
            value={selectedProviderId}
            onChange={(e) => setSelectedProviderId(e.target.value)}
            className="w-full p-2 border rounded"
            disabled={isSubmitting}
          >
            {providers.map((provider) => (
              <option
                key={provider.id}
                value={provider.id}
                disabled={!resolveProviderReadiness(provider).canCreateShipment}
              >
                {provider.name} - {getProviderReadinessLabel(resolveProviderReadiness(provider))}
              </option>
            ))}
          </select>
          {selectedBlocker && (
            <p className="mt-2 rounded border border-yellow-200 bg-yellow-50 p-2 text-sm text-yellow-800">
              {selectedBlocker}
            </p>
          )}
          {readyProviderCount === 0 && (
            <p className="mt-2 rounded border border-yellow-200 bg-yellow-50 p-2 text-sm text-yellow-800">
              No shipment-ready providers.{" "}
              {getProviderReadinessMessage(resolveProviderReadiness(providers[0]))}
            </p>
          )}
        </div>

        <div className="flex space-x-2 pt-2">
          <button
            type="submit"
            className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={
              isSubmitting ||
              !selectedProviderId ||
              selectedReadiness?.canCreateShipment === false
            }
          >
            {isSubmitting ? "Creating..." : "Create Shipment"}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition-colors"
              disabled={isSubmitting}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export { ShipmentForm };
