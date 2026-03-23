import { type FC } from "react";

interface ShipmentStatusBadgeProps {
  status: string;
}

const ShipmentStatusBadge: FC<ShipmentStatusBadgeProps> = ({ status }) => {
  const getStatusProperties = (statusCode: string) => {
    const normalizedStatus = statusCode.toUpperCase();

    switch (normalizedStatus) {
      case "PENDING":
      case "ON_HOLD":
        return {
          text: normalizedStatus === "ON_HOLD" ? "On Hold" : "Pending",
          className: "bg-amber-100 text-amber-800",
        };
      case "PICKED_UP":
        return {
          text: "Picked Up",
          className: "bg-blue-100 text-blue-800",
        };
      case "IN_TRANSIT":
      case "IN_REVIEW":
      case "PROCESSING":
        return {
          text:
            normalizedStatus === "IN_TRANSIT"
              ? "In Transit"
              : normalizedStatus === "IN_REVIEW"
                ? "In Review"
                : "Processing",
          className: "bg-blue-100 text-blue-800",
        };
      case "DELIVERED":
      case "COMPLETED":
        return {
          text: normalizedStatus === "DELIVERED" ? "Delivered" : "Completed",
          className: "bg-green-100 text-green-800",
        };
      case "FAILED":
      case "ERROR":
        return {
          text: normalizedStatus === "FAILED" ? "Failed" : "Error",
          className: "bg-red-100 text-red-800",
        };
      case "CANCELLED":
        return {
          text: "Cancelled",
          className: "bg-gray-100 text-gray-800",
        };
      case "RETURNED":
      case "RETURNED_APPROVAL_PENDING":
      case "PARTIAL_DELIVERED_APPROVAL_PENDING":
        return {
          text: normalizedStatus.includes("RETURNED")
            ? "Returned"
            : "Partially Delivered",
          className: "bg-purple-100 text-purple-800",
        };
      case "UNKNOWN":
        return {
          text: "Unknown",
          className: "bg-gray-100 text-gray-800",
        };
      default:
        // Format custom status (capitalize words and replace underscores with spaces)
        const formattedText = status
          .split("_")
          .map(
            (word) =>
              word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
          )
          .join(" ");

        return {
          text: formattedText || "Unknown",
          className: "bg-gray-100 text-gray-800",
        };
    }
  };

  const { text, className } = getStatusProperties(status);

  return (
    <span className={`px-2 py-1 text-xs font-medium rounded-full ${className}`}>
      {text}
    </span>
  );
};

export { ShipmentStatusBadge };
