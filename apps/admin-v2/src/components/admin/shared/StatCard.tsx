import React from "react";
import { Card, CardContent } from "../../ui/card";
import { cn } from "@scalius/shared/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ElementType;
  iconBgColor?: string;
  iconTextColor?: string;
}

const DEFAULT_ICON_BG = "bg-gray-100";
const DEFAULT_ICON_TEXT = "text-gray-600";

export const StatCard = React.memo(function StatCard({
  title,
  value,
  icon: Icon,
  iconBgColor = DEFAULT_ICON_BG,
  iconTextColor = DEFAULT_ICON_TEXT,
}: StatCardProps) {
  return (
    <Card className="shadow-sm hover:shadow-md transition-shadow duration-200">
      <CardContent className="p-2 flex items-center space-x-2">
        <div className={cn("rounded-full p-2", iconBgColor)}>
          <Icon className={cn("h-3.5 w-3.5", iconTextColor)} />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {title}
          </p>
          <p className="text-base font-bold text-foreground">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
});
