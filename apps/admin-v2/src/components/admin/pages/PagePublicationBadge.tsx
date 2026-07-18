import { CalendarClock, CircleDashed, Globe2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getPagePublicationMode, type PagePublicationFacts } from "@/lib/page-publication";

export function PagePublicationBadge({ page }: { page: PagePublicationFacts }) {
  const mode = getPagePublicationMode(page);

  if (mode === "published") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
        <Globe2 className="h-3 w-3" /> Live
      </Badge>
    );
  }

  if (mode === "scheduled") {
    return (
      <Badge variant="outline" className="gap-1 border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
        <CalendarClock className="h-3 w-3" /> Scheduled
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="gap-1">
      <CircleDashed className="h-3 w-3" /> Draft
    </Badge>
  );
}
