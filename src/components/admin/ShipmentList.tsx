import { useState, useEffect, type FC } from "react";
import { ShipmentStatusBadge } from "./ShipmentStatusBadge";
import { ShipmentMetadataDisplay } from "../ui/ShipmentMetadataDisplay";
import { toast } from "sonner";

interface Shipment {
  id: string;
  orderId: string;
  providerId: string;
  providerName: string;
  externalId: string;
  trackingId?: string;
  status: string;
  metadata: string;
  createdAt: string;
  updatedAt: string;
  lastChecked?: string;
}

interface ShipmentListProps {
  orderId: string;
  onRefresh?: () => void;
}

const ShipmentList: FC<ShipmentListProps> = ({ orderId, onRefresh }) => {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<Record<string, boolean>>({});
  const [selectedShipment, setSelectedShipment] = useState<Shipment | null>(
    null,
  );
  const [showMetadata, setShowMetadata] = useState<boolean>(false);

  // Load shipments
  const fetchShipments = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/orders/${orderId}/shipments`);
      if (!response.ok) {
        throw new Error("Failed to fetch shipments");
      }

      const data = await response.json();
      // Initialize lastChecked to updatedAt for existing shipments
      const enhancedData = data.map((shipment: Shipment) => ({
        ...shipment,
        lastChecked: shipment.lastChecked || shipment.updatedAt,
      }));
      setShipments(enhancedData);
    } catch (error) {
      console.error("Error fetching shipments:", error);
      toast.error("Failed to load shipments");
    } finally {
      setIsLoading(false);
    }
  };

  // Load shipments on component mount
  useEffect(() => {
    fetchShipments();
  }, [orderId]);

  // Refresh shipment status
  const handleRefreshStatus = async (shipment: Shipment) => {
    setIsRefreshing((prev) => ({ ...prev, [shipment.id]: true }));
    try {
      // First update the lastChecked time
      const now = new Date().toISOString();
      setShipments((prev) =>
        prev.map((s) =>
          s.id === shipment.id ? { ...s, lastChecked: now } : s,
        ),
      );

      const response = await fetch(
        `/api/orders/${orderId}/shipments/${shipment.id}/refresh`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error("Failed to refresh shipment status");
      }

      const updatedShipment = await response.json();

      // Add the lastChecked timestamp to the updated shipment
      updatedShipment.lastChecked = now;

      // Update the shipment in the list
      setShipments((prevShipments) =>
        prevShipments.map((s) =>
          s.id === updatedShipment.id ? updatedShipment : s,
        ),
      );

      // Show appropriate message based on status change
      if (updatedShipment.status !== shipment.status) {
        toast.success(`Status updated to: ${updatedShipment.status}`);
      } else {
        toast.info("Shipment status is up to date");
      }

      // If this was the selected shipment, update it
      if (selectedShipment?.id === updatedShipment.id) {
        setSelectedShipment(updatedShipment);
      }

      if (onRefresh) {
        onRefresh();
      }
    } catch (error) {
      console.error("Error refreshing shipment status:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to refresh status",
      );
    } finally {
      setIsRefreshing((prev) => ({ ...prev, [shipment.id]: false }));
    }
  };

  // Delete shipment
  const handleDelete = async (shipment: Shipment) => {
    if (!confirm(`Are you sure you want to delete this shipment?`)) {
      return;
    }

    try {
      const response = await fetch(
        `/api/orders/${orderId}/shipments/${shipment.id}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        throw new Error("Failed to delete shipment");
      }

      // Remove from list
      setShipments((prevShipments) =>
        prevShipments.filter((s) => s.id !== shipment.id),
      );

      // Clear selected if it was this one
      if (selectedShipment?.id === shipment.id) {
        setSelectedShipment(null);
        setShowMetadata(false);
      }

      toast.success("Shipment deleted");

      if (onRefresh) {
        onRefresh();
      }
    } catch (error) {
      console.error("Error deleting shipment:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete shipment",
      );
    }
  };

  // View shipment details
  const handleViewDetails = (shipment: Shipment) => {
    setSelectedShipment(shipment);
    setShowMetadata(true);
  };

  // Format date for display
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  };

  // Calculate relative time for last checked
  const getRelativeTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) {
      return `${diffInSeconds} sec${diffInSeconds !== 1 ? "s" : ""} ago`;
    }

    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) {
      return `${diffInMinutes} min${diffInMinutes !== 1 ? "s" : ""} ago`;
    }

    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) {
      return `${diffInHours} hour${diffInHours !== 1 ? "s" : ""} ago`;
    }

    const diffInDays = Math.floor(diffInHours / 24);
    return `${diffInDays} day${diffInDays !== 1 ? "s" : ""} ago`;
  };

  if (isLoading && shipments.length === 0) {
    return <div className="text-center py-4">Loading shipments...</div>;
  }

  if (shipments.length === 0) {
    return (
      <div className="text-center py-4 text-gray-500">
        No shipments found for this order.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="font-medium">Shipments</h3>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Provider
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Tracking ID
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Status
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Last Checked
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-gray-500">
                Created
              </th>
              <th className="px-4 py-2 text-right text-sm font-medium text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shipments.map((shipment) => (
              <tr key={shipment.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">{shipment.providerName}</td>
                <td className="px-4 py-3">
                  {shipment.trackingId || shipment.externalId || "-"}
                </td>
                <td className="px-4 py-3">
                  <ShipmentStatusBadge status={shipment.status} />
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {shipment.lastChecked ? (
                    <span title={formatDate(shipment.lastChecked)}>
                      {getRelativeTime(shipment.lastChecked)}
                    </span>
                  ) : (
                    "Never"
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {formatDate(shipment.createdAt)}
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button
                    onClick={() => handleRefreshStatus(shipment)}
                    className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 items-center space-x-1 inline-flex"
                    disabled={isRefreshing[shipment.id]}
                  >
                    {isRefreshing[shipment.id] ? (
                      <>
                        <svg
                          className="animate-spin h-3 w-3 mr-1"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                            fill="none"
                          ></circle>
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          ></path>
                        </svg>
                        <span>Refreshing</span>
                      </>
                    ) : (
                      <>
                        <svg
                          className="h-3 w-3 mr-1"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          ></path>
                        </svg>
                        <span>Refresh</span>
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => handleViewDetails(shipment)}
                    className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                  >
                    Details
                  </button>
                  <button
                    onClick={() => handleDelete(shipment)}
                    className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Shipment Details Modal */}
      {showMetadata && selectedShipment && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium">Shipment Details</h3>
              <button
                onClick={() => setShowMetadata(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <span className="text-2xl">&times;</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <p className="text-sm font-medium text-gray-500">Provider</p>
                <p>{selectedShipment.providerName}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Status</p>
                <ShipmentStatusBadge status={selectedShipment.status} />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">External ID</p>
                <p>{selectedShipment.externalId || "-"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Tracking ID</p>
                <p>{selectedShipment.trackingId || "-"}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">Created</p>
                <p>{formatDate(selectedShipment.createdAt)}</p>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-500">
                  Last Checked
                </p>
                <p
                  title={
                    selectedShipment.lastChecked
                      ? formatDate(selectedShipment.lastChecked)
                      : ""
                  }
                >
                  {selectedShipment.lastChecked
                    ? getRelativeTime(selectedShipment.lastChecked)
                    : "Never"}
                </p>
              </div>
            </div>

            <div className="mb-4">
              <h4 className="text-sm font-medium text-gray-500 mb-2">
                Metadata
              </h4>
              <ShipmentMetadataDisplay metadata={selectedShipment.metadata} />
            </div>

            <div className="flex justify-end space-x-2">
              <button
                onClick={() => handleRefreshStatus(selectedShipment)}
                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 inline-flex items-center"
                disabled={isRefreshing[selectedShipment.id]}
              >
                {isRefreshing[selectedShipment.id] ? (
                  <>
                    <svg
                      className="animate-spin h-4 w-4 mr-2"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                        fill="none"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    <span>Refreshing Status...</span>
                  </>
                ) : (
                  <>
                    <svg
                      className="h-4 w-4 mr-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                      ></path>
                    </svg>
                    <span>Refresh Status</span>
                  </>
                )}
              </button>
              <button
                onClick={() => setShowMetadata(false)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export { ShipmentList };
