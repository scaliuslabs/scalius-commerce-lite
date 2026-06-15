import type { UseFormReturn } from "react-hook-form";
import { Badge } from "../../../ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../ui/card";
import { formatDateShort } from "@scalius/shared/timestamps";
import type { FormValues, Product, Collection } from "./types";

interface SummaryCardProps {
  form: UseFormReturn<FormValues>;
  symbol: string;
  selectedProducts: Product[];
  selectedCollections: Collection[];
}

export function SummaryCard({
  form,
  symbol,
  selectedProducts,
  selectedCollections,
}: SummaryCardProps) {
  return (
    <Card className="bg-muted/30 border-dashed">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-medium">
          Discount Summary
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="text-muted-foreground">Code</div>
          <div className="font-mono font-semibold tracking-wider">
            {form.watch("code") || "---"}
          </div>
          <div className="text-muted-foreground">Value</div>
          <div className="font-medium">
            {form.watch("valueType") === "percentage"
              ? `${form.watch("discountValue") || 0}% off`
              : `${symbol}${form.watch("discountValue") || 0} off`}
          </div>
          <div className="text-muted-foreground">Applies to</div>
          <div className="font-medium">
            {selectedProducts.length > 0 || selectedCollections.length > 0
              ? `${selectedProducts.length} product(s), ${selectedCollections.length} collection(s)`
              : "No products selected"}
          </div>
          <div className="text-muted-foreground">Min. purchase</div>
          <div className="font-medium">
            {form.watch("minPurchaseAmount")
              ? `${symbol}${form.watch("minPurchaseAmount")}`
              : "None"}
          </div>
          <div className="text-muted-foreground">Usage limit</div>
          <div className="font-medium">
            {form.watch("maxUses")
              ? `${form.watch("maxUses")} total`
              : "Unlimited"}
            {form.watch("limitOnePerCustomer") ? " (1 per customer)" : ""}
          </div>
          <div className="text-muted-foreground">Period</div>
          <div className="font-medium" suppressHydrationWarning>
            {form.watch("startDate")
              ? formatDateShort(form.watch("startDate")!)
              : "---"}
            {" — "}
            {form.watch("endDate")
              ? formatDateShort(form.watch("endDate")!)
              : "No end date"}
          </div>
          <div className="text-muted-foreground">Status</div>
          <div>
            <Badge
              variant={form.watch("isActive") ? "default" : "outline"}
              className={
                form.watch("isActive")
                  ? "bg-green-100 text-green-800 border-green-200"
                  : ""
              }
            >
              {form.watch("isActive") ? "Active" : "Inactive"}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
