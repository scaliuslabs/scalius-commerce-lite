// src/components/admin/pages-list/components/PageStatistics.tsx
import { Card, CardContent } from "@/components/ui/card";
import { FileText, CheckCircle, FileEdit } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PageStatisticsProps } from "../types";

const StatCard = ({
  title,
  value,
  icon: Icon,
  iconBgColor = "bg-gray-100",
  iconTextColor = "text-gray-600",
}: {
  title: string;
  value: string | number;
  icon: React.ElementType;
  iconBgColor?: string;
  iconTextColor?: string;
}) => (
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

export function PageStatistics({
  total,
  publishedCount,
  draftCount,
}: PageStatisticsProps) {
  return (
    <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      <StatCard
        title="Total Pages"
        value={total}
        icon={FileText}
        iconBgColor="bg-blue-100 dark:bg-blue-900/30"
        iconTextColor="text-blue-600 dark:text-blue-400"
      />
      <StatCard
        title="Published"
        value={publishedCount}
        icon={CheckCircle}
        iconBgColor="bg-green-100 dark:bg-green-900/30"
        iconTextColor="text-green-600 dark:text-green-400"
      />
      <StatCard
        title="Drafts"
        value={draftCount}
        icon={FileEdit}
        iconBgColor="bg-orange-100 dark:bg-orange-900/30"
        iconTextColor="text-orange-600 dark:text-orange-400"
      />
    </div>
  );
}
