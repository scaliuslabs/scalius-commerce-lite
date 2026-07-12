import React, { type SVGProps } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../ui/card";
import { Button } from "../../ui/button";
import { Tag, Percent, Truck } from "lucide-react";

interface DiscountType {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
}

interface DiscountTypeSelectorProps {
  onSelect?: (typeId: string) => void;
}

export function DiscountTypeSelector({ onSelect }: DiscountTypeSelectorProps) {
  const discountTypes: DiscountType[] = [
    {
      id: "amount_off_products",
      name: "Amount Off Products",
      description: "Reduce selected products or collections.",
      icon: <Tag />,
    },
    {
      id: "amount_off_order",
      name: "Amount Off Order",
      description: "Reduce the merchandise subtotal.",
      icon: <Percent />,
    },
    {
      id: "free_shipping",
      name: "Free Shipping",
      description: "Waive the delivery charge for qualifying orders.",
      icon: <Truck />,
    },
  ];

  const handleSelect = (typeId: string) => {
    if (onSelect) {
      onSelect(typeId);
    }
  };

  return (
    <Card id="discount-type-selector" className="w-full border bg-card shadow-none">
      <CardHeader className="px-4 pb-3 pt-4 sm:px-5">
        <CardTitle className="text-lg font-semibold tracking-tight">
          What should this code reduce?
        </CardTitle>
        <CardDescription className="text-sm text-muted-foreground pt-1">
          One code can apply to products, the order subtotal, or delivery.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 sm:px-5">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {discountTypes.map((type) => (
            <Button
              key={type.id}
              variant="outline"
              className="group h-auto min-h-28 w-full flex-col items-start justify-start gap-2 whitespace-normal rounded-md border bg-card p-4 text-left shadow-none hover:border-foreground/20 hover:bg-muted/50"
              onClick={() => handleSelect(type.id)}
            >
              {React.isValidElement(type.icon)
                ? React.cloneElement(
                    type.icon as React.ReactElement<SVGProps<SVGSVGElement>>,
                    {
                      className: "h-5 w-5 text-muted-foreground transition-colors group-hover:text-foreground",
                      "aria-hidden": "true",
                    },
                  )
                : null}

              <div
                className="text-sm font-semibold text-foreground"
              >
                {type.name}
              </div>

              <div className="text-xs leading-5 text-muted-foreground">
                {type.description}
              </div>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
