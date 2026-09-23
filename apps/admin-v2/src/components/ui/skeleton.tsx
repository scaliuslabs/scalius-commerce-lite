import { cn } from "@scalius/shared/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-lg bg-secondary", className)} {...props} />;
}

export { Skeleton };
