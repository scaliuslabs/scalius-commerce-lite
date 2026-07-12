import type { OrderReturnDto } from "@/lib/order-return-workflow";
import type { OrderItem } from "../types";
import { getOrderItemName } from "./shared";

export function ReturnLineSummary({
  line,
  item,
}: {
  line: OrderReturnDto["lines"][number];
  item: OrderItem | undefined;
}) {
  return (
    <div className="grid gap-1 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <p className="truncate font-medium text-foreground">{getOrderItemName(item)}</p>
        {line.reason ? <p className="truncate text-muted-foreground">{line.reason}</p> : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground sm:justify-end">
        <span>Requested {line.requestedQuantity}</span>
        <span>Approved {line.approvedQuantity}</span>
        <span>Received {line.receivedQuantity}</span>
        {line.restockQuantity > 0 ? <span>Restocked {line.restockQuantity}</span> : null}
        {line.damagedQuantity > 0 ? <span>Damaged {line.damagedQuantity}</span> : null}
      </div>
    </div>
  );
}
