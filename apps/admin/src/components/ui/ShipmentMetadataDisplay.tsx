import React from "react";
import { Card, CardContent } from "./card";

interface ShipmentMetadataDisplayProps {
  metadata: any;
  className?: string;
}

/**
 * Component to display shipment metadata in a structured way
 */
export function ShipmentMetadataDisplay({
  metadata,
  className = "",
}: ShipmentMetadataDisplayProps) {
  let parsedMetadata = metadata;

  // Parse metadata if it's a string
  if (typeof metadata === "string") {
    try {
      parsedMetadata = JSON.parse(metadata);
    } catch (error) {
      console.error("Error parsing shipment metadata:", error);
      return (
        <Card className={`${className}`}>
          <CardContent className="p-3">
            <p className="text-sm text-muted-foreground">
              Error parsing metadata: {String(error)}
            </p>
          </CardContent>
        </Card>
      );
    }
  }

  // If metadata is null or undefined
  if (!parsedMetadata) {
    return (
      <Card className={`${className}`}>
        <CardContent className="p-3">
          <p className="text-sm text-muted-foreground">No metadata available</p>
        </CardContent>
      </Card>
    );
  }

  // Function to render metadata values
  const renderValue = (value: any): React.ReactNode => {
    if (value === null || value === undefined) {
      return <span className="text-muted-foreground italic">None</span>;
    }

    if (typeof value === "object") {
      return (
        <div className="text-sm">
          {Object.entries(value).map(([subKey, subValue]) => (
            <div key={subKey} className="pl-2 border-l-2 border-muted my-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">
                  {formatKey(subKey)}:
                </span>
                <span>{renderValue(subValue)}</span>
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (typeof value === "boolean") {
      return value ? "Yes" : "No";
    }

    return String(value);
  };

  // Format key for display
  const formatKey = (key: string): string => {
    return key
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  };

  // Filter out less important metadata fields
  const importantKeys = Object.entries(parsedMetadata).filter(
    ([key]) => !["id", "created_at", "updated_at"].includes(key),
  );

  return (
    <Card className={`${className}`}>
      <CardContent className="p-3 space-y-2">
        <div className="text-sm space-y-1.5">
          {importantKeys.length > 0 ? (
            importantKeys.map(([key, value]) => (
              <div key={key} className="flex justify-between">
                <span className="text-muted-foreground">{formatKey(key)}:</span>
                <span>{renderValue(value)}</span>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              No metadata available
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
