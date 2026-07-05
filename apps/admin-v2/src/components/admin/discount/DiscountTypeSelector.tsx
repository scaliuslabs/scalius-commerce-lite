import React, { useRef, type SVGProps } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../ui/card";
import { Button } from "../../ui/button";
import { Tag, Percent, Truck } from "lucide-react";
import { cn } from "@scalius/shared/utils";

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
  const containerRef = useRef<HTMLDivElement>(null);

  const discountTypes: DiscountType[] = [
    {
      id: "amount_off_products",
      name: "Amount Off Products",
      description:
        "Apply a percentage or fixed discount to specific products or collections. Best for targeted promotions.",
      icon: <Tag />,
    },
    {
      id: "amount_off_order",
      name: "Amount Off Order",
      description:
        "Apply a percentage or fixed discount to the entire order total. Best for site-wide sales and loyalty rewards.",
      icon: <Percent />,
    },
    {
      id: "free_shipping",
      name: "Free Shipping",
      description:
        "Waive shipping fees for qualifying orders. Best for increasing average order value.",
      icon: <Truck />,
    },
  ];

  const handleSelect = (typeId: string) => {
    if (onSelect) {
      onSelect(typeId);
    }
  };

  return (
    <Card
      id="discount-type-selector"
      ref={containerRef}
      className={cn(
        "w-full border bg-card shadow-sm",
        "transition-all duration-300",
      )}
    >
      <CardHeader className="pb-5">
        <CardTitle className="text-lg font-semibold tracking-tight">
          Select Discount Type
        </CardTitle>
        <CardDescription className="text-sm text-muted-foreground pt-1">
          Choose the type of discount you want to create. This sets the
          foundation for your promotion.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {discountTypes.map((type) => (
            <Button
              key={type.id}
              variant="outline"
              className={cn(
                "w-full h-full flex flex-col items-start justify-start p-5 gap-2.5",
                "border bg-card hover:bg-accent hover:border-primary/50",
                "rounded-lg shadow-sm hover:shadow-md focus-visible:shadow-md",
                "transition-all duration-200 ease-out group cursor-pointer text-left",
                "transform-gpu hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] focus-visible:-translate-y-0.5",
                "whitespace-normal",
              )}
              onClick={() => handleSelect(type.id)}
            >
              {React.isValidElement(type.icon)
                ? React.cloneElement(
                    type.icon as React.ReactElement<SVGProps<SVGSVGElement>>,
                    {
                      className: cn(
                        "h-6 w-6 text-primary mb-2",
                        "transition-colors duration-200",
                      ),
                      "aria-hidden": "true",
                    },
                  )
                : null}

              <div
                className={cn(
                  "font-semibold text-md text-foreground group-hover:text-primary",
                  "transition-colors duration-200 mb-1",
                )}
              >
                {type.name}
              </div>

              <div className="text-sm text-muted-foreground leading-normal">
                {type.description}
              </div>
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
