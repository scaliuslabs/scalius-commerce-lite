import { useState, useEffect, type FC } from "react";
import type { DeliveryProvider } from "@/db/schema";
import { toast } from "sonner";

interface ShipmentFormProps {
  orderId: string;
  onSuccess?: (shipment: any) => void;
  onCancel?: () => void;
}

const ShipmentForm: FC<ShipmentFormProps> = ({
  orderId,
  onSuccess,
  onCancel,
}) => {
  const [providers, setProviders] = useState<DeliveryProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Load active providers on component mount
  useEffect(() => {
    const fetchProviders = async () => {
      setIsLoading(true);
      try {
        const response = await fetch("/api/settings/delivery-providers");
        if (!response.ok) {
          throw new Error("Failed to fetch providers");
        }

        const data = await response.json();
        // Only show active providers
        const activeProviders = data.filter(
          (p: DeliveryProvider) => p.isActive,
        );
        setProviders(activeProviders);

        // Select the first provider by default if available
        if (activeProviders.length > 0) {
          setSelectedProviderId(activeProviders[0].id);
        }
      } catch (error) {
        console.error("Error fetching providers:", error);
        toast.error("Failed to load delivery providers");
      } finally {
        setIsLoading(false);
      }
    };

    fetchProviders();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedProviderId) {
      toast.error("Please select a delivery provider");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/orders/${orderId}/shipments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          providerId: selectedProviderId,
          options: {}, // Can be extended for custom options per provider
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create shipment");
      }

      const shipment = await response.json();
      toast.success("Shipment created successfully");

      if (onSuccess) {
        onSuccess(shipment);
      }
    } catch (error) {
      console.error("Error creating shipment:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to create shipment",
      );
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
        <h3 className="font-medium">No active delivery providers</h3>
        <p className="text-sm mt-1">
          Please set up and activate a delivery provider in settings before
          creating shipments.
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

  return (
    <div className="border rounded p-4">
      <h3 className="font-medium mb-4">Create Shipment</h3>
      <form onSubmit={handleSubmit} className="space-y-4">
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
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex space-x-2 pt-2">
          <button
            type="submit"
            className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={isSubmitting || !selectedProviderId}
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
