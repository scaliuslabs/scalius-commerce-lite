import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Bot,
  ChevronLeft,
  ChevronRight,
  Clock3,
  KeyRound,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  Store,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";

import {
  EmptyState,
  IndexFilters,
  IndexTable,
  PageHeader,
  StatusBadge,
  type IndexTableColumn,
  type PageHeaderLinkProps,
  type StatusTone,
} from "~/components/admin/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { getServerFnError } from "~/lib/api-helpers";

import {
  agentClearableConnectionsQueryOptions,
  agentConnectionsQueryOptions,
  purgeRevokedAgentConnections,
  revokeAllAgentGrants,
} from "./api";
import { ConnectionDetails } from "./ConnectionDetails";
import { formatAgentAccessDate } from "./ConnectionTable";
import { CreateTokenDialog } from "./CreateTokenDialog";
import { PurgeRevokedDialog } from "./PurgeRevokedDialog";
import { RevokeDialog } from "./RevokeDialog";
import type {
  AgentConnection,
  AgentConnectionStatusFilter,
  AgentGrantKind,
  AgentResource,
} from "./types";

const PAGE_SIZE = 20;
const ALL = "all";
/** Default list: pending + active, so revoked and expired history stays out of the way. */
const DEFAULT_STATUS: StatusFilter = "current";
const EMPTY_CONNECTIONS: AgentConnection[] = [];

const STATUS_TONES: Record<AgentConnection["status"], StatusTone> = {
  active: "success",
  pending: "attention",
  revoked: "critical",
  expired: "neutral",
};

type StatusFilter = AgentConnectionStatusFilter | typeof ALL;
type KindFilter = AgentGrantKind | typeof ALL;
type ResourceFilter = AgentResource | typeof ALL;

function BreadcrumbLink({ href, className, onClick, children }: PageHeaderLinkProps) {
  return (
    <Link to={href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}

function ConnectionKindIcon({ kind }: Pick<AgentConnection, "kind">) {
  if (kind === "oauth") return <Bot aria-hidden="true" />;
  if (kind === "cli") return <TerminalSquare aria-hidden="true" />;
  return <KeyRound aria-hidden="true" />;
}

function connectionName(connection: AgentConnection): string {
  return connection.label || connection.clientName || "Unnamed connection";
}

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
  const [status, setStatus] = useState<StatusFilter>(DEFAULT_STATUS);
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
  const clearableQuery = useQuery(agentClearableConnectionsQueryOptions());

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

  const purgeRevokedMutation = useMutation({
    mutationFn: () => purgeRevokedAgentConnections(),
    onSuccess: async (result) => {
      toast.success(
        result.count === 0
          ? "No revoked or expired connections were found"
          : `${result.count} ${result.count === 1 ? "connection" : "connections"} permanently deleted`,
      );
      await invalidateConnections(queryClient);
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Connections could not be cleared"));
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

  const columns: IndexTableColumn<AgentConnection>[] = [
    {
      id: "connection",
      header: "Connection",
      mobileLabel: "Connection",
      cell: (connection) => (
        <span className="flex min-w-0 items-center gap-3 py-1.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
            <ConnectionKindIcon kind={connection.kind} />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{connectionName(connection)}</span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {connection.kind.toUpperCase()} · {connection.ownerName ?? "Former admin"}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: "access",
      header: "Access",
      mobileLabel: "Access",
      cell: (connection) => (
        <span className="flex flex-wrap items-center justify-end gap-1.5 sm:justify-start">
          <StatusBadge tone={STATUS_TONES[connection.status]} srLabel="Status:">
            {connection.status}
          </StatusBadge>
          <StatusBadge tone="info" dot={false} srLabel="Resource:">
            <span className="flex items-center gap-1">
              {connection.resource === "dashboard" ? (
                <Bot className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Store className="h-3 w-3" aria-hidden="true" />
              )}
              {connection.resource}
            </span>
          </StatusBadge>
          <StatusBadge tone="neutral" dot={false} srLabel="Scope:">
            {connection.preset}
          </StatusBadge>
        </span>
      ),
    },
    {
      id: "lastUsed",
      header: "Last used",
      mobileLabel: "Last used",
      className: "text-xs text-muted-foreground",
      cell: (connection) => formatAgentAccessDate(connection.lastUsedAt),
    },
    {
      id: "expires",
      header: "Expires",
      mobileLabel: "Expires",
      hideOnMobile: true,
      className: "text-xs text-muted-foreground",
      cell: (connection) => formatAgentAccessDate(connection.expiresAt),
    },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-5 py-2 sm:py-4">
      <PageHeader
        title="Agent access"
        subtitle="Approve, scope, inspect, revoke, and clear every MCP, CLI, and personal-token connection to this store."
        breadcrumbs={[
          { label: "Settings", href: "/admin/settings" },
          { label: "Agent access" },
        ]}
        linkComponent={BreadcrumbLink}
      >
        <CreateTokenDialog
          availablePermissions={availablePermissions}
          canManage={canManage}
          onCreated={() => invalidateConnections(queryClient)}
        />
        <PurgeRevokedDialog
          clearable={clearableQuery.data}
          disabled={!canManage}
          pending={purgeRevokedMutation.isPending}
          onConfirm={() => purgeRevokedMutation.mutateAsync()}
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
      </PageHeader>

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
            Access management permission must create, rotate, narrow, revoke, or
            clear them.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-3">
        <IndexFilters
          label="Filter agent connections"
          searchValue={query}
          onSearchChange={setQuery}
          searchPlaceholder="Search this page"
          actions={
            <>
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
                  <SelectItem value="current">Current</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="revoked">Revoked</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                  <SelectItem value={ALL}>All statuses</SelectItem>
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
            </>
          }
        />

        {connectionsQuery.error ? (
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
        ) : (
          <IndexTable
            label="Agent connections"
            items={filtered}
            columns={columns}
            getRowId={(connection) => connection.id}
            loading={connectionsQuery.isPending}
            loadingRowCount={3}
            onRowClick={setSelectedConnection}
            rowActions={(connection) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 sm:h-9 sm:w-9"
                    aria-label={`Actions for ${connectionName(connection)}`}
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setSelectedConnection(connection)}>
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    Inspect connection
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            empty={
              connections.length === 0 ? (
                <EmptyState
                  icon={TerminalSquare}
                  heading={
                    status === "current"
                      ? "No current agent connections"
                      : "No agent connections"
                  }
                  body="Create a personal token here, connect an MCP client through OAuth, or run the CLI pairing command."
                  secondaryAction={
                    status === "current" && (clearableQuery.data?.total ?? 0) > 0
                      ? {
                          label: "Show revoked and expired connections",
                          onClick: () => {
                            setStatus(ALL);
                            setPage(1);
                          },
                        }
                      : undefined
                  }
                >
                  <p className="text-xs text-muted-foreground">
                    CLI pairing runs{" "}
                    <code className="rounded bg-muted px-1 py-0.5">scalius auth login</code>.
                  </p>
                </EmptyState>
              ) : (
                <EmptyState
                  icon={Clock3}
                  heading="No connections match these filters"
                  body="Clear the search and filters to see the current connections again."
                  action={{
                    label: "Clear filters",
                    variant: "outline",
                    onClick: () => {
                      setQuery("");
                      setStatus(DEFAULT_STATUS);
                      setKind(ALL);
                      setResource(ALL);
                      setPage(1);
                    },
                  }}
                />
              )
            }
            footer={
              pagination && pagination.totalPages > 1 ? (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {pagination.total} {status === "current" ? "current" : "matching"} connections
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-9"
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
                      className="min-h-11 sm:min-h-9"
                      disabled={page >= pagination.totalPages}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ) : null
            }
          />
        )}
      </div>

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
