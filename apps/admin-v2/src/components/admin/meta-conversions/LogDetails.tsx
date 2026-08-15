import type { MetaConversionsLog } from "./hooks/useMetaConversionsLogs";

function safeJsonParse(jsonString: string): unknown {
  try {
    return JSON.parse(jsonString);
  } catch {
    return { error: "Invalid JSON format" };
  }
}

interface LogDetailsProps {
  log: MetaConversionsLog;
}

export function LogDetails({ log }: LogDetailsProps) {
  return (
    <div className="mt-3 space-y-4 rounded-md bg-muted/50 p-3">
      <div>
        <h4 className="mb-1 text-sm font-medium">Privacy-safe request summary</h4>
        <p className="mb-2 text-xs text-muted-foreground">
          Shows which matching and commerce fields were supplied, never customer identifiers or credentials.
        </p>
        <div className="w-full overflow-hidden">
          <pre className="text-xs bg-background p-3 rounded border overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(safeJsonParse(log.requestPayload), null, 2)}
          </pre>
        </div>
      </div>

      {log.responsePayload && (
        <div>
          <h4 className="mb-2 text-sm font-medium">Provider response</h4>
          <div className="w-full overflow-hidden">
            <pre className="text-xs bg-background p-3 rounded border overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(safeJsonParse(log.responsePayload), null, 2)}
            </pre>
          </div>
        </div>
      )}

      {log.errorMessage && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-destructive">Delivery error</h4>
          <div className="w-full overflow-hidden">
            <p className="text-sm text-destructive bg-destructive/10 p-3 rounded border whitespace-pre-wrap break-words">
              {log.errorMessage}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
