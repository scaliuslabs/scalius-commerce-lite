import { AlertTriangle, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getSettingsLoadErrorMessage } from "@/hooks/use-settings-form";

interface SettingsLoadFailureProps {
  title: string;
  error: unknown;
  fallback: string;
  onRetry: () => void | Promise<unknown>;
}

export function SettingsLoadFailure({
  title,
  error,
  fallback,
  onRetry,
}: SettingsLoadFailureProps) {
  return (
    <Alert variant="destructive" className="max-w-2xl" role="alert">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{getSettingsLoadErrorMessage(error, fallback)}</p>
        <p className="text-xs">
          No defaults were assumed and saving stays locked until the current
          settings load.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onRetry()}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
