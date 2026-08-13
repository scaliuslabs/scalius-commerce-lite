import {
  Bot,
  ChevronRight,
  Clock3,
  KeyRound,
  Store,
  TerminalSquare,
} from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import type { AgentConnection } from "./types";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-BD", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : DATE_FORMATTER.format(parsed);
}

function ConnectionKindIcon({ kind }: Pick<AgentConnection, "kind">) {
  if (kind === "oauth") return <Bot aria-hidden="true" />;
  if (kind === "cli") return <TerminalSquare aria-hidden="true" />;
  return <KeyRound aria-hidden="true" />;
}

function statusVariant(status: AgentConnection["status"]) {
  if (status === "active") return "default" as const;
  if (status === "pending") return "secondary" as const;
  return "outline" as const;
}

interface ConnectionTableProps {
  connections: AgentConnection[];
  onInspect: (connection: AgentConnection) => void;
}

export function ConnectionTable({ connections, onInspect }: ConnectionTableProps) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/35 hover:bg-muted/35">
              <TableHead className="pl-4">Connection</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="w-12"><span className="sr-only">Details</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <TableRow
                key={connection.id}
                className="cursor-pointer"
                onClick={() => onInspect(connection)}
              >
                <TableCell className="pl-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
                      <ConnectionKindIcon kind={connection.kind} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {connection.label || connection.clientName || "Unnamed connection"}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {connection.kind.toUpperCase()} · {connection.ownerName ?? "Former admin"}
                      </span>
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={statusVariant(connection.status)}>{connection.status}</Badge>
                    <Badge variant="outline" className="gap-1">
                      {connection.resource === "dashboard" ? (
                        <Bot className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Store className="h-3 w-3" aria-hidden="true" />
                      )}
                      {connection.resource}
                    </Badge>
                    <Badge variant="secondary">{connection.preset}</Badge>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(connection.lastUsedAt)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDate(connection.expiresAt)}
                </TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Inspect ${connection.label || connection.clientName || "connection"}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onInspect(connection);
                    }}
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-2 md:hidden">
        {connections.map((connection) => (
          <button
            key={connection.id}
            type="button"
            className="w-full rounded-lg border bg-card p-3 text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onInspect(connection)}
          >
            <span className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
                <ConnectionKindIcon kind={connection.kind} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {connection.label || connection.clientName || "Unnamed connection"}
                  </span>
                  <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </span>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant={statusVariant(connection.status)}>{connection.status}</Badge>
                  <Badge variant="outline">{connection.resource}</Badge>
                  <Badge variant="secondary">{connection.preset}</Badge>
                </span>
                <span className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                  Used {formatDate(connection.lastUsedAt)}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

export { formatDate as formatAgentAccessDate };
