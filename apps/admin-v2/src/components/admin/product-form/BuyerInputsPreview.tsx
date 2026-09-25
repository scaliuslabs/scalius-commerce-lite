import React from "react";
import type { CustomizationSchema } from "@scalius/shared/line-properties";
import { LinePropertyFields } from "@/components/admin/order-form/LinePropertyFields";

/**
 * The block the buyer fills on the product page, live from the editor's
 * inputs (loaded when the merchant opens the preview).
 */
export function BuyerInputsPreview({ schema, surcharge }: {
  schema: CustomizationSchema;
  surcharge: (priceMinor: number) => string;
}) {
  const [values, setValues] = React.useState<Record<string, string>>({});
  return (
    <LinePropertyFields
      schema={schema}
      values={values}
      onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
      error={null}
      surcharge={surcharge}
    />
  );
}
