import { type FC, useState, useEffect } from "react";
import type { DeliveryProvider, DeliveryShipment, Order } from "@/db/schema";
import { toast } from "sonner"; 
import { formatDate } from "@/lib/utils";
import ShipmentStatusIndicator from "./ShipmentStatusIndicator";

// Extend the DeliveryShipment type to include properties used in component
interface ExtendedDeliveryShipment extends DeliveryShipment {
  providerName?: string;
  trackingNumber?: string | null;
}

interface DeliveryShipmentManagerProps {
  order: Order;
  providers: DeliveryProvider[];
  shipments: ExtendedDeliveryShipment[];
}

declare global {
  interface Window {
    shipmentActions: {
      createShipment: (
        orderId: string,
        providerId: string,
        options?: any,
      ) => Promise<any>;
      checkShipmentStatus: (shipmentId: string) => Promise<any>;
      deleteShipment: (shipmentId: string) => Promise<boolean>;
    };
  }
}

const DeliveryShipmentManager: FC<DeliveryShipmentManagerProps> = ({
  order,
  providers,
  shipments: initialShipments,
}) => {
  const [shipments, setShipments] =
    useState<ExtendedDeliveryShipment[]>(initialShipments);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [isCreating, setIsCreating] = useState(false);
  const [isChecking, setIsChecking] = useState<Record<string, boolean>>({});
  const [isDeleting, setIsDeleting] = useState<Record<string, boolean>>({});
  const [codAmount, setCodAmount] = useState<number>(
    order.totalAmount + order.shippingCharge - (order.discountAmount || 0),
  );

  // Add provider names to shipments
  useEffect(() => {
    const providerMap = new Map<string, string>();
    providers.forEach((provider) => {
      providerMap.set(provider.id, provider.name);
    });

    const updatedShipments = initialShipments.map((shipment) => ({
      ...shipment,
      providerName:
        (shipment.providerId ? providerMap.get(shipment.providerId) : undefined)
        ?? shipment.courierName
        ?? "Manual",
      trackingNumber: shipment.trackingId,
    }));

    setShipments(updatedShipments);
  }, [initialShipments, providers]);

  // Handle provider selection
  const handleProviderChange = (id: string) => {
    setSelectedProviderId(id);
  };

  // Create shipment
  const handleCreateShipment = async () => {
    if (!selectedProviderId) {
      toast.error("Please select a delivery provider");
      return;
    }

    setIsCreating(true);
    try {
      if (!window.shipmentActions) {
        toast.error("Shipment actions not available");
        return;
      }

      const options = {
        codAmount: codAmount || 0,
      };

      // Find the provider to log details
      const provider = providers.find((p) => p.id === selectedProviderId);
      console.log(
        `Creating shipment with ${provider?.name} (${selectedProviderId}) for order: ${order.id}`,
      );
      console.log("Shipment options:", options);

      const result = await window.shipmentActions.createShipment(
        order.id,
        selectedProviderId,
        options,
      );

      console.log("Create shipment API response:", result);

      if (!result.success) {
        throw new Error(result.message || "Failed to create shipment");
      }

      const shipment = result.data;
      console.log("Shipment created successfully:", shipment);

      // Add the new shipment to the list
      setShipments((prev) => [
        {
          ...shipment,
          providerName: provider?.name || shipment.providerType,
          trackingNumber: shipment.trackingId,
        },
        ...prev,
      ]);

      toast.success("Shipment created successfully");

      // Refresh the page to update the order status if needed
      setTimeout(() => window.location.reload(), 1500);

      setSelectedProviderId("");
    } catch (error) {
      console.error("Error creating shipment:", error);
      toast.error(
        `Error creating shipment: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsCreating(false);
    }
  };

  // Check shipment status
  const handleCheckStatus = async (shipmentId: string) => {
    setIsChecking((prev) => ({ ...prev, [shipmentId]: true }));
    try {
      if (!window.shipmentActions) {
        toast.error("Shipment actions not available");
        return;
      }

      const result =
        await window.shipmentActions.checkShipmentStatus(shipmentId);

      if (!result.success) {
        throw new Error(result.message || "Failed to check shipment status");
      }

      // Update the shipment in the list with detailed info
      setShipments((prev) =>
        prev.map((s) =>
          s.id === shipmentId
            ? {
                ...s,
                status: result.data.status,
                rawStatus: result.data.rawStatus,
                metadata: result.data.metadata,
                lastChecked:
                  result.data.lastChecked || new Date().toISOString(),
              }
            : s,
        ),
      );

      if (result.data.statusChanged) {
        toast.success(`Status updated to: ${result.data.status}`);

        // If order status was also updated, refresh the page to show the new status
        if (result.data.orderStatusUpdate) {
          setTimeout(() => window.location.reload(), 1500);
        }
      } else {
        toast.info("Shipment status is up to date");
      }
    } catch (error) {
      toast.error(
        `Error checking status: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsChecking((prev) => ({ ...prev, [shipmentId]: false }));
    }
  };

  // Delete shipment
  const handleDeleteShipment = async (shipmentId: string) => {
    if (!confirm("Are you sure you want to delete this shipment?")) {
      return;
    }

    setIsDeleting((prev) => ({ ...prev, [shipmentId]: true }));
    try {
      if (!window.shipmentActions) {
        toast.error("Shipment actions not available");
        return;
      }

      await window.shipmentActions.deleteShipment(shipmentId);
      setShipments((prev) => prev.filter((s) => s.id !== shipmentId));
      toast.success("Shipment deleted");
    } catch (error) {
      toast.error(
        `Error deleting shipment: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsDeleting((prev) => ({ ...prev, [shipmentId]: false }));
    }
  };

  // Format JSON data for display
  const formatMetadata = (metadata: string) => {
    try {
      const data = JSON.parse(metadata);
      return Object.entries(data)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
    } catch (error) {
      return metadata;
    }
  };

  // Render shipment status with improved display
  const renderShipmentStatus = (shipment: ExtendedDeliveryShipment) => {
    // Convert lastChecked to string format for the component
    const formattedShipment = {
      id: shipment.id,
      status: shipment.status,
      orderId: shipment.orderId,
      lastChecked: shipment.lastChecked
        ? typeof shipment.lastChecked === "string"
          ? shipment.lastChecked
          : shipment.lastChecked instanceof Date
            ? shipment.lastChecked.toISOString()
            : undefined
        : undefined,
    };

    return (
      <ShipmentStatusIndicator
        shipment={formattedShipment}
        onStatusUpdated={(updatedShipment) => {
          // Update the shipment in the list
          setShipments((prev) =>
            prev.map((s) =>
              s.id === updatedShipment.id
                ? {
                    ...s,
                    status: updatedShipment.status,
                    lastChecked: updatedShipment.lastChecked,
                  }
                : s,
            ),
          );
        }}
      />
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Delivery Management</h2>
      </div>

      {/* Create New Shipment */}
      <div className="border rounded p-4">
        <h3 className="font-medium mb-4">Create New Shipment</h3>

        {providers.length === 0 ? (
          <p className="text-amber-600">
            No active delivery providers available. Please configure providers
            first.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Select Provider
                </label>
                <select
                  value={selectedProviderId}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  className="w-full p-2 border rounded"
                  disabled={isCreating}
                >
                  <option value="">-- Select a provider --</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Cash on Delivery Amount
                </label>
                <input
                  type="number"
                  value={codAmount}
                  onChange={(e) => setCodAmount(Number(e.target.value))}
                  min="0"
                  className="w-full p-2 border rounded"
                  disabled={isCreating}
                />
              </div>
            </div>

            <div className="flex">
              <button
                onClick={handleCreateShipment}
                className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isCreating || !selectedProviderId}
              >
                {isCreating ? "Creating..." : "Create Shipment"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Shipments History */}
      <div className="border rounded p-4">
        <h3 className="font-medium mb-4">Shipment History</h3>

        {shipments.length === 0 ? (
          <p className="text-gray-500">
            No shipments have been created for this order.
          </p>
        ) : (
          <div className="space-y-4">
            <h3 className="font-medium">Shipments</h3>
            <div className="border rounded overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Provider
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Tracking #
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Created
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {shipments.map((shipment) => (
                    <tr key={shipment.id}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {shipment.providerName}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-500">
                          {shipment.trackingNumber || "-"}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {renderShipmentStatus(shipment)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {formatDate(
                          typeof shipment.createdAt === "number"
                            ? new Date(shipment.createdAt * 1000)
                            : shipment.createdAt,
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <div className="flex space-x-2">
                          <button
                            onClick={() => handleCheckStatus(shipment.id)}
                            className="text-blue-600 hover:text-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={isChecking[shipment.id]}
                          >
                            {isChecking[shipment.id]
                              ? "Checking..."
                              : "Check Status"}
                          </button>
                          <button
                            onClick={() => handleDeleteShipment(shipment.id)}
                            className="text-red-600 hover:text-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={isDeleting[shipment.id]}
                          >
                            {isDeleting[shipment.id] ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Additional Shipment Details */}
      {shipments.length > 0 && (
        <div className="border rounded p-4">
          <h3 className="font-medium mb-4">Latest Shipment Details</h3>

          <div className="space-y-4">
            {/* Provider Details */}
            <div>
              <h4 className="text-sm font-semibold mb-2">
                Provider Information
              </h4>
              <ul className="list-disc list-inside space-y-1 text-sm ml-2">
                <li>
                  Provider:{" "}
                  {shipments[0].providerName || shipments[0].providerType}
                </li>
                <li>Provider Type: {shipments[0].providerType}</li>
                <li>External ID: {shipments[0].externalId || "N/A"}</li>
                <li>
                  Tracking Number:{" "}
                  {shipments[0].trackingNumber ||
                    shipments[0].trackingId ||
                    "N/A"}
                </li>
              </ul>
            </div>

            {/* Shipment Metadata */}
            <div>
              <h4 className="text-sm font-semibold mb-2">Metadata</h4>
              <div className="text-sm border-l-2 border-gray-200 pl-3 ml-2">
                {shipments[0].metadata ? (
                  <pre className="whitespace-pre-wrap">
                    {formatMetadata(shipments[0].metadata)}
                  </pre>
                ) : (
                  <p className="text-gray-500">No metadata available</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export { DeliveryShipmentManager };
