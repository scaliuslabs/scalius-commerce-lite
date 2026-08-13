import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Bot,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { getServerFnError } from "~/lib/api-helpers";

import {
  agentConnectionsQueryOptions,
  revokeAllAgentGrants,
} from "./api";
import { ConnectionDetails } from "./ConnectionDetails";
import { ConnectionTable } from "./ConnectionTable";
import { CreateTokenDialog } from "./CreateTokenDialog";
import { RevokeDialog } from "./RevokeDialog";
import type {
  AgentConnection,
  AgentGrantKind,
  AgentGrantStatus,
  AgentResource,
} from "./types";

const PAGE_SIZE = 20;
const ALL = "all";
const EMPTY_CONNECTIONS: AgentConnection[] = [];

type StatusFilter = AgentGrantStatus | typeof ALL;
type KindFilter = AgentGrantKind | typeof ALL;
type ResourceFilter = AgentResource | typeof ALL;

interface AgentAccessSettingsPageProps {
  availablePermissions: string[];
  canManage: boolean;
}

export function AgentAccessSettingsPage({
  availablePermissions,
  canManage,
}: AgentAccessSettingsPageProps) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>(ALL);
  const [kind, setKind] = useState<KindFilter>(ALL);
  const [resource, setResource] = useState<ResourceFilter>(ALL);
  const [selectedConnection, setSelectedConnection] =
    useState<AgentConnection | null>(null);

  const connectionsQuery = useQuery(
    agentConnectionsQueryOptions(page, PAGE_SIZE, {
      ...(status === ALL ? {} : { status }),
      ...(kind === ALL ? {} : { kind }),
      ...(resource === ALL ? {} : { resource }),
    }),
  );
  const connections = connectionsQuery.data?.connections ?? EMPTY_CONNECTIONS;

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return connections.filter((connection) => {
      if (!needle) return true;
      return [
        connection.label,
        connection.clientName,
        connection.ownerName,
        connection.lastOperationId,
        connection.id,
        ...connection.credentials.map((credential) => credential.tokenHint),
      ].some((value) => value?.toLocaleLowerCase().includes(needle));
    });
  }, [connections, query]);

  const revokeAllMutation = useMutation({
    mutationFn: (reason: string) => revokeAllAgentGrants(reason),
    onSuccess: async (result) => {
      toast.success(
        result.count === 0
          ? "No active connections were found"
          : `${result.count} ${result.count === 1 ? "connection" : "connections"} revoked`,
      );
      await invalidateConnections(queryClient);
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Connections could not be revoked"));
    },
  });

  const activeCount = connections.filter((item) => item.status === "active").length;
  const dashboardCount = connections.filter(
    (item) => item.status === "active" && item.resource === "dashboard",
  ).length;
  const storefrontCount = connections.filter(
    (item) => item.status === "active" && item.resource === "storefront",
  ).length;
  const pagination = connectionsQuery.data?.pagination;

  return (
    <div className="mx-auto max-w-7xl space-y-5 py-2 sm:py-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border bg-card text-muted-foreground">
              <Bot className="h-4 w-4" aria-hidden="true" />
            </span>
            <h1 className="text-xl font-semibold tracking-tight">Agent Access</h1>
          </div>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Approve, scope, inspect, and revoke every MCP, CLI, and personal-token
            connection to this store.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CreateTokenDialog
            availablePermissions={availablePermissions}
            canManage={canManage}
            onCreated={() => invalidateConnections(queryClient)}
          />
          <RevokeDialog
            title="Revoke every agent connection?"
            description="All active MCP, CLI, and personal-token grants stop on their next request. This cannot be undone."
            confirmLabel="Revoke all connections"
            triggerLabel="Revoke all"
            triggerVariant="destructive"
            disabled={!canManage}
            pending={revokeAllMutation.isPending}
            onConfirm={(reason) => revokeAllMutation.mutateAsync(reason)}
          />
        </div>
      </header>

      <div className="grid gap-2 sm:grid-cols-3">
        <Card className="shadow-none">
          <CardContent className="flex items-center gap-3 p-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-lg font-semibold tabular-nums">{activeCount}</p>
              <p className="text-xs text-muted-foreground">Active on this page</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardContent className="flex items-center gap-3 p-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-400">
              <Bot className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-lg font-semibold tabular-nums">{dashboardCount}</p>
              <p className="text-xs text-muted-foreground">Dashboard on this page</p>
            </div>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardContent className="flex items-center gap-3 p-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-400">
              <Store className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-lg font-semibold tabular-nums">{storefrontCount}</p>
              <p className="text-xs text-muted-foreground">Storefront on this page</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {!canManage ? (
        <Alert>
          <KeyRound aria-hidden="true" />
          <AlertTitle>View-only access</AlertTitle>
          <AlertDescription>
            You can inspect connections and activity. A Super Admin with Agent
            Access management permission must create, rotate, narrow, or revoke them.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="shadow-none">
        <CardContent className="space-y-3 p-3 sm:p-4">
          <div className="grid gap-2 lg:grid-cols-[minmax(14rem,1fr)_repeat(3,minmax(9rem,auto))_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search this page"
                className="min-h-11 pl-9 sm:min-h-9"
                aria-label="Search agent connections on this page"
              />
            </div>
            <Select
              value={resource}
              onValueChange={(value) => {
                setResource(value as ResourceFilter);
                setPage(1);
              }}
            >
              <SelectTrigger className="min-h-11 sm:min-h-9" aria-label="Filter by resource">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All resources</SelectItem>
                <SelectItem value="dashboard">Dashboard</SelectItem>
                <SelectItem value="storefront">Storefront</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value as KindFilter);
                setPage(1);
              }}
            >
              <SelectTrigger className="min-h-11 sm:min-h-9" aria-label="Filter by connection kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All connection types</SelectItem>
                <SelectItem value="oauth">OAuth / MCP</SelectItem>
                <SelectItem value="pat">Personal token</SelectItem>
                <SelectItem value="cli">CLI</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as StatusFilter);
                setPage(1);
              }}
            >
              <SelectTrigger className="min-h-11 sm:min-h-9" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="revoked">Revoked</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-11 w-11 sm:h-9 sm:w-9"
              aria-label="Refresh connections"
              onClick={() => void connectionsQuery.refetch()}
              disabled={connectionsQuery.isFetching}
            >
              <RefreshCw
                className={`h-4 w-4 ${connectionsQuery.isFetching ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
            </Button>
          </div>

          {connectionsQuery.isPending ? (
            <div className="space-y-2" role="status" aria-label="Loading connections">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : connectionsQuery.error ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>Connections are unavailable</AlertTitle>
              <AlertDescription>
                No access changes are safe until the live connection list loads.
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void connectionsQuery.refetch()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : connections.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-10 text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border bg-muted/30 text-muted-foreground">
                <TerminalSquare className="h-5 w-5" aria-hidden="true" />
              </div>
              <h2 className="mt-3 text-sm font-semibold">No agent connections</h2>
              <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                Create a personal token here, connect an MCP client through OAuth,
                or run <code className="rounded bg-muted px-1 py-0.5">scalius auth login</code> for CLI pairing.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="text-sm font-medium">No connections match these filters</p>
              <Button
                type="button"
                variant="link"
                className="mt-1"
                onClick={() => {
                  setQuery("");
                  setStatus(ALL);
                  setKind(ALL);
                  setResource(ALL);
                  setPage(1);
                }}
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <ConnectionTable
              connections={filtered}
              onInspect={setSelectedConnection}
            />
          )}

          {pagination && pagination.totalPages > 1 ? (
            <div className="flex items-center justify-between border-t pt-3">
              <p className="text-xs text-muted-foreground">
                {pagination.total} total connections
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  Previous
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {page} / {pagination.totalPages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConnectionDetails
        connection={selectedConnection}
        open={selectedConnection !== null}
        canManage={canManage}
        onOpenChange={(open) => !open && setSelectedConnection(null)}
        onChanged={() => invalidateConnections(queryClient)}
      />
    </div>
  );
}

async function invalidateConnections(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: ["agent-access"] });
}
