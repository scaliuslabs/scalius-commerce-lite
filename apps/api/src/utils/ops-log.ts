type OpsLogLevel = "info" | "warn" | "error";
type OpsLogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | OpsLogValue[]
  | { [key: string]: OpsLogValue };

export type OpsLogMetadata = Record<string, OpsLogValue>;

function withoutUndefined(value: OpsLogValue): OpsLogValue {
  if (Array.isArray(value)) {
    return value.map((item) => withoutUndefined(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, Exclude<OpsLogValue, undefined>] => entry[1] !== undefined)
        .map(([key, entryValue]) => [key, withoutUndefined(entryValue)]),
    );
  }

  return value;
}

export function logOpsEvent(
  level: OpsLogLevel,
  event: string,
  metadata: OpsLogMetadata = {},
): void {
  const payload = withoutUndefined({ event, ...metadata });
  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error("[api-ops]", line);
    return;
  }
  if (level === "warn") {
    console.warn("[api-ops]", line);
    return;
  }
  console.log("[api-ops]", line);
}
