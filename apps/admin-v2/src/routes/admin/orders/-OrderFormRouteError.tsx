import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";

export function OrderFormRouteError({
  title,
  description,
  error,
  reset,
}: {
  title: string;
  description: string;
  error: Error;
  reset: () => void;
}) {
  return (
    <section
      role="alert"
      className="mx-4 mt-8 max-w-xl rounded-lg border bg-card p-5 shadow-sm sm:mx-auto"
    >
      <h1 className="text-base font-semibold">{title}</h1>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      {error.message ? (
        <p className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {error.message}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={reset}>
          Try again
        </Button>
        <Button asChild type="button" size="sm" variant="outline">
          <Link to="/admin/orders">Back to orders</Link>
        </Button>
      </div>
    </section>
  );
}
