import React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { Badge } from "../../ui/badge";
import { LoaderCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// Type for the items fetched for the popover
type PopoverOrderItem = {
  id: string; // Order item ID
  productId: string;
  productName: string | null;
  productImage: string | null;
  variantId: string | null;
  variantSize: string | null;
  variantColor: string | null;
  quantity: number;
  price: number; // Price per unit
};

interface OrderItemsPopoverProps {
  orderId: string;
  itemCount: number;
}

export function OrderItemsPopover({
  orderId,
  itemCount,
}: OrderItemsPopoverProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = React.useState(false);
  const [items, setItems] = React.useState<PopoverOrderItem[] | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);

  const handleOpenChange = async (open: boolean) => {
    setIsOpen(open);
    if (open && !items) {
      // Fetch only if opening and items haven't been fetched yet
      setIsLoading(true);
      try {
        const response = await fetch(`/api/orders/${orderId}/items`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to fetch order items");
        }
        const data: PopoverOrderItem[] = await response.json();
        setItems(data);
      } catch (error) {
        console.error("Failed to fetch order items:", error);
        setItems([]); // Set to empty array on error to prevent re-fetching
        toast({
          title: "Error",
          description: "Could not load order items.",
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Badge
          variant="secondary"
          className="cursor-pointer text-xs font-medium transition-all duration-200 hover:scale-105 hover:bg-[var(--muted)]"
        >
          {itemCount.toLocaleString()} {itemCount === 1 ? "item" : "items"}
        </Badge>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-3 z-50 bg-[var(--popover)] text-[var(--popover-foreground)]"
        align="start"
      >
        <div className="space-y-2">
          <h4 className="font-medium leading-none text-sm mb-2">Order Items</h4>
          {isLoading ? (
            <div className="flex items-center justify-center h-20">
              <LoaderCircle className="animate-spin h-5 w-5 text-[var(--muted-foreground)]" />
            </div>
          ) : items && items.length > 0 ? (
            <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600 pr-1">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="flex justify-between items-start gap-2 text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <p
                      className="truncate font-medium text-[var(--foreground)]"
                      title={item.productName || ""}
                    >
                      {item.productName || "N/A"}
                    </p>
                    {(item.variantSize || item.variantColor) && (
                      <p className="text-[var(--muted-foreground)] truncate">
                        {item.variantSize}
                        {item.variantSize && item.variantColor ? " / " : ""}
                        {item.variantColor}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0 whitespace-nowrap">
                    <p className="text-[var(--muted-foreground)]">
                      {item.quantity} x ৳{item.price.toLocaleString()}
                    </p>
                    <p className="font-medium text-[var(--foreground)]">
                      ৳{(item.quantity * item.price).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--muted-foreground)] text-center py-4">
              No items found or failed to load.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
