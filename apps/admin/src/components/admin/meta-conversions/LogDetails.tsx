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
    <div className="p-4 bg-muted/50 rounded-lg space-y-4">
      <div>
        <h4 className="font-medium mb-2">Request Payload</h4>
        <div className="w-full overflow-hidden">
          <pre className="text-xs bg-background p-3 rounded border overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(safeJsonParse(log.requestPayload), null, 2)}
          </pre>
        </div>
      </div>

      {log.responsePayload && (
        <div>
          <h4 className="font-medium mb-2">Response Payload</h4>
          <div className="w-full overflow-hidden">
            <pre className="text-xs bg-background p-3 rounded border overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(safeJsonParse(log.responsePayload), null, 2)}
            </pre>
          </div>
        </div>
      )}

      {log.errorMessage && (
        <div>
          <h4 className="font-medium mb-2 text-destructive">Error Message</h4>
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
