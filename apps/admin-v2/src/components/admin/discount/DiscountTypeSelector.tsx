import React, { type SVGProps } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../ui/card";
import { Button } from "../../ui/button";
import { ChevronRight, Tag, Percent, Truck } from "lucide-react";

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
      name: "Amount off products",
      description: "Reduce specific products or collections with a percentage or fixed amount.",
      icon: <Tag />,
    },
    {
      id: "amount_off_order",
      name: "Amount off order",
      description: "Reduce the merchandise subtotal after eligible product savings.",
      icon: <Percent />,
    },
    {
      id: "free_shipping",
      name: "Free shipping",
      description: "Waive the delivery charge when the order meets your requirements.",
      icon: <Truck />,
    },
  ];

  const handleSelect = (typeId: string) => {
    if (onSelect) {
      onSelect(typeId);
    }
  };

  return (
    <Card id="discount-type-selector" className="w-full max-w-3xl border bg-card shadow-none">
      <CardHeader className="px-4 pb-3 pt-4 sm:px-5">
        <CardTitle className="text-lg font-semibold tracking-tight">
          What should this code reduce?
        </CardTitle>
        <CardDescription className="text-sm text-muted-foreground pt-1">
          One code can apply to products, the order subtotal, or delivery.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 sm:px-5">
        <div className="divide-y rounded-md border">
          {discountTypes.map((type) => (
            <Button
              key={type.id}
              type="button"
              variant="outline"
              className="group grid h-auto min-h-20 w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 whitespace-normal rounded-none border-0 bg-card px-3 py-3 text-left shadow-none first:rounded-t-md last:rounded-b-md hover:bg-muted/50 sm:px-4"
              onClick={() => handleSelect(type.id)}
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-md border bg-muted/30">
                {React.isValidElement(type.icon)
                  ? React.cloneElement(
                      type.icon as React.ReactElement<SVGProps<SVGSVGElement>>,
                      {
                        className: "h-[18px] w-[18px] text-muted-foreground transition-colors group-hover:text-foreground",
                        "aria-hidden": "true",
                      },
                    )
                  : null}
              </div>

              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{type.name}</div>
                <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {type.description}
                </div>
              </div>

              <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
