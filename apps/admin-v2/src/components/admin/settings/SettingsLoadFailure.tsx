import { ErrorState } from "~/components/admin/states/ErrorState";
import { Card } from "~/components/ui/card";

/**
 * One settings card whose read failed (polish bar R3): the card keeps its
 * place with one line and Retry, the other cards still render, and saving
 * stays locked until it loads.
 */
export function SettingsLoadFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error?: unknown;
  onRetry: () => void | Promise<unknown>;
}) {
  return (
    <Card className="p-4">
      <ErrorState layout="inline" title={title} error={error} onRetry={() => void onRetry()} />
    </Card>
  );
}
