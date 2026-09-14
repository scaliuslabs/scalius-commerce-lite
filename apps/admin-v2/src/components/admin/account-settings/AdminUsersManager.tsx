import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
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
import {
  Loader2,
  Shield,
  UserPlus,
  Trash2,
  AlertCircle,
  Users,
  RefreshCw,
  UserCheck,
  UserX,
  ChevronDown,
  MoreHorizontal,
} from "lucide-react";
import { usePermissions } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  EmptyState,
  FieldError,
  IndexFilters,
  IndexTable,
  InlineHelp,
  SettingsSection,
  StatusBadge,
  type IndexFilterPill,
  type IndexTableColumn,
  type StatusTone,
} from "~/components/admin/shell";
import { UserPermissionEditor } from "../UserPermissionEditor";
import { useAdminUsers, type AdminUser } from "./hooks/useAdminUsers";
import { useHydrated } from "~/hooks/use-hydrated";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";
import {
  ADMIN_USER_STATUS_COPY,
  getAdminUserStatus,
  isAdminUserAuthorityReady,
  type AdminUserStatus,
} from "./admin-user-status";

/** Status pills above the list. `all` is the unfiltered default. */
type StatusFilterId = "all" | "ready" | "setup" | "suspended";

const STATUS_TONES: Record<AdminUserStatus, StatusTone> = {
  ready: "success",
  suspended: "critical",
  invite_pending: "attention",
  invite_expired: "warning",
  invite_delivery_failed: "critical",
  password_setup: "attention",
  two_factor_setup: "attention",
};

function getInitials(name: string): string {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
}

function isInvitationStatus(status: AdminUserStatus): boolean {
  return status === "invite_pending"
    || status === "invite_expired"
    || status === "invite_delivery_failed";
}

function getInvitationActionLabel(status: AdminUserStatus): string {
  if (status === "invite_expired") return "Send new link";
  if (status === "invite_delivery_failed") return "Retry delivery";
  return "Resend setup";
}

function splitAdminUsersBySuspension(adminUsers: AdminUser[]): {
  activeUsers: AdminUser[];
  suspendedUsers: AdminUser[];
} {
  const activeUsers: AdminUser[] = [];
  const suspendedUsers: AdminUser[] = [];
  for (const adminUser of adminUsers) {
    if (getAdminUserStatus(adminUser) === "suspended") {
      suspendedUsers.push(adminUser);
    } else {
      activeUsers.push(adminUser);
    }
  }
  return { activeUsers, suspendedUsers };
}

/** The status pill an administrator belongs to, independent of the search text. */
function matchesStatusFilter(
  status: AdminUserStatus,
  filter: StatusFilterId,
): boolean {
  if (filter === "all") return true;
  if (filter === "suspended") return status === "suspended";
  if (filter === "ready") return status === "ready";
  return status !== "ready" && status !== "suspended";
}

function filterAdminUsers(
  adminUsers: AdminUser[],
  normalizedQuery: string,
  statusFilter: StatusFilterId,
): AdminUser[] {
  return adminUsers.filter((adminUser) => {
    const status = getAdminUserStatus(adminUser);
    if (!matchesStatusFilter(status, statusFilter)) return false;
    if (!normalizedQuery) return true;
    return [
      adminUser.name,
      adminUser.email,
      ADMIN_USER_STATUS_COPY[status].label,
      ...adminUser.roles.map((role) => role.displayName),
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}

function getInvitationTiming(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (remainingMinutes < 60) return `${remainingMinutes}m`;
  return `${Math.ceil(remainingMinutes / 60)}h`;
}

interface AdminUsersManagerProps {
  currentUserId: string;
}

export function AdminUsersManager({ currentUserId }: AdminUsersManagerProps) {
  const {
    adminUsers,
    availableRoles,
    isLoading,
    isLoadingRoles,
    usersError,
    rolesError,
    addUser,
    deleteUser,
    refetch,
    refetchRoles,
    resendSetup,
    updateSuspension,
  } = useAdminUsers();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<AdminUser | null>(null);
  const [suspendingUser, setSuspendingUser] = useState<AdminUser | null>(null);
  const [resendingUserId, setResendingUserId] = useState<string | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilterId>("all");
  const [suspendedOpen, setSuspendedOpen] = useState(false);
  const { hasPermission } = usePermissions();
  const canManageTeam = hasPermission(PERMISSIONS.TEAM_MANAGE);
  const canManageRoles = hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES);
  const isHydrated = useHydrated();
  const userAuthorityReady = isAdminUserAuthorityReady({
    isLoading,
    error: usersError,
  });
  const normalizedQuery = query.trim().toLowerCase();
  const { activeUsers, suspendedUsers } = useMemo(
    () => splitAdminUsersBySuspension(adminUsers),
    [adminUsers],
  );
  const filteredActiveUsers = useMemo(
    () => filterAdminUsers(activeUsers, normalizedQuery, statusFilter),
    [activeUsers, normalizedQuery, statusFilter],
  );
  const filteredSuspendedUsers = useMemo(
    () => filterAdminUsers(suspendedUsers, normalizedQuery, statusFilter),
    [suspendedUsers, normalizedQuery, statusFilter],
  );
  const hasQuery = normalizedQuery.length > 0;
  const hasFilter = hasQuery || statusFilter !== "all";
  // A search or status pill that matches a suspended administrator opens the
  // section so the match is visible without an extra click.
  const showSuspendedOpen = suspendedOpen || (hasFilter && filteredSuspendedUsers.length > 0);

  const statusPills: IndexFilterPill[] = useMemo(() => {
    const counts: Record<StatusFilterId, number> = {
      all: adminUsers.length,
      ready: 0,
      setup: 0,
      suspended: 0,
    };
    for (const adminUser of adminUsers) {
      const status = getAdminUserStatus(adminUser);
      if (status === "suspended") counts.suspended += 1;
      else if (status === "ready") counts.ready += 1;
      else counts.setup += 1;
    }
    return [
      { id: "all", label: "All", count: counts.all },
      { id: "ready", label: "Ready", count: counts.ready },
      { id: "setup", label: "Setup pending", count: counts.setup },
      { id: "suspended", label: "Suspended", count: counts.suspended },
    ];
  }, [adminUsers]);

  const resetInviteForm = () => {
    setShowAddForm(false);
    setNewUserName("");
    setNewUserEmail("");
    setSelectedRoleId("");
    setError(null);
  };

  const clearFilters = () => {
    setQuery("");
    setStatusFilter("all");
  };

  const handleResendSetup = async (userId: string) => {
    setResendingUserId(userId);
    try {
      await resendSetup(userId);
    } catch (resendError) {
      toast.error(
        resendError instanceof Error
          ? resendError.message
          : "Could not resend the setup email",
      );
    } finally {
      setResendingUserId(null);
    }
  };

  const handleAddUser = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setError(null);
    setIsAdding(true);

    try {
      await addUser(newUserName, newUserEmail, selectedRoleId);
      resetInviteForm();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not send this invitation");
    } finally {
      setIsAdding(false);
    }
  };

  const handleSuspension = async (adminUser: AdminUser, suspended: boolean) => {
    setUpdatingUserId(adminUser.id);
    try {
      await updateSuspension(adminUser.id, suspended);
    } catch (suspensionError) {
      toast.error(
        suspensionError instanceof Error
          ? suspensionError.message
          : suspended
            ? "Could not suspend this administrator"
            : "Could not restore this administrator",
      );
    } finally {
      setUpdatingUserId(null);
    }
  };

  const columns: IndexTableColumn<AdminUser>[] = [
    {
      id: "administrator",
      header: "Administrator",
      mobileLabel: "Administrator",
      cell: (adminUser) => (
        <span className="flex min-w-0 items-center gap-3 py-1.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10">
            {adminUser.image ? (
              <img
                src={getOptimizedImageUrl(
                  adminUser.image,
                  ADMIN_IMAGE_PRESETS.avatar,
                )}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <span className="text-xs font-medium text-primary">
                {getInitials(adminUser.name)}
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5 font-medium">
              <span className="truncate">{adminUser.name}</span>
              {adminUser.id === currentUserId && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  You
                </span>
              )}
              {adminUser.isSuperAdmin && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  Super Admin
                </span>
              )}
            </span>
            <span className="block break-words text-xs text-muted-foreground">
              {adminUser.email}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: "access",
      header: "Access",
      mobileLabel: "Access",
      cell: (adminUser) => (
        <span className="flex min-w-0 flex-wrap justify-end gap-1.5 sm:justify-start">
          {adminUser.roles.length > 0 ? (
            adminUser.roles.map((role) => (
              <span
                key={role.id}
                className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
              >
                {role.displayName}
              </span>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No assigned role</span>
          )}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      mobileLabel: "Status",
      cell: (adminUser) => (
        <AdminStatusBadge
          status={getAdminUserStatus(adminUser)}
          invitation={adminUser.invitation}
        />
      ),
    },
  ];

  const renderRowActions = (adminUser: AdminUser) => {
    const status = getAdminUserStatus(adminUser);
    const isOther = adminUser.id !== currentUserId && !adminUser.isSuperAdmin;
    const canResend = canManageTeam && isInvitationStatus(status);
    const canRestore = canManageTeam && isOther && status === "suspended";
    const canEditPermissions = canManageRoles && isOther;
    const canRevokeInvite = canManageTeam && isOther && isInvitationStatus(status);
    const canSuspend =
      canManageTeam
      && isOther
      && !isInvitationStatus(status)
      && status !== "password_setup"
      && status !== "suspended";
    const hasMenu = canEditPermissions || canRevokeInvite || canSuspend;

    if (!canResend && !canRestore && !hasMenu) return null;

    return (
      <span className="flex items-center justify-end gap-1">
        {canRestore && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 text-xs sm:min-h-9"
            onClick={() => void handleSuspension(adminUser, false)}
            disabled={!userAuthorityReady || updatingUserId !== null}
          >
            {updatingUserId === adminUser.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Restore access
          </Button>
        )}
        {canResend && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 text-xs sm:min-h-9"
            onClick={() => void handleResendSetup(adminUser.id)}
            disabled={!userAuthorityReady || resendingUserId !== null}
          >
            {resendingUserId === adminUser.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {getInvitationActionLabel(status)}
          </Button>
        )}
        {hasMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-11 w-11 sm:h-9 sm:w-9"
                aria-label={`Actions for ${adminUser.name}`}
                disabled={!userAuthorityReady}
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEditPermissions && (
                <DropdownMenuItem onSelect={() => setEditingUser(adminUser)}>
                  <Shield className="h-4 w-4" aria-hidden="true" />
                  Permissions
                </DropdownMenuItem>
              )}
              {canRevokeInvite && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => setRevokingInvite(adminUser)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Revoke invitation
                </DropdownMenuItem>
              )}
              {canSuspend && (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={updatingUserId !== null}
                  onSelect={() => setSuspendingUser(adminUser)}
                >
                  <UserX className="h-4 w-4" aria-hidden="true" />
                  Suspend access
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
    );
  };

  const showLoadingSkeleton = isLoading && adminUsers.length === 0;
  const noMatches =
    !showLoadingSkeleton
    && adminUsers.length > 0
    && filteredActiveUsers.length === 0
    && filteredSuspendedUsers.length === 0;

  return (
    <SettingsSection
      title="Administrators"
      description="People who can sign in to this dashboard, and whether their secure setup is finished."
      actions={
        <>
          <span
            data-testid="admin-users-count"
            className="mr-auto rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground"
          >
            {activeUsers.length}
          </span>
          {canManageTeam && (
            <Button
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={() => setShowAddForm(true)}
              disabled={showAddForm || !userAuthorityReady}
            >
              <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
              Invite administrator
            </Button>
          )}
        </>
      }
    >
      {canManageTeam && showAddForm && (
        <form
          method="post"
          action="/admin/settings/account"
          onSubmit={handleAddUser}
          className="mb-4 space-y-3 rounded-lg border bg-muted/20 p-4"
          noValidate
        >
          <div>
            <h4 className="text-sm font-semibold">Invite an administrator</h4>
            <InlineHelp>
              They receive a one-use setup link and must configure a password and 2FA.
            </InlineHelp>
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="newUserName">Full name</Label>
              <Input
                id="newUserName"
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                placeholder="Samira Rahman"
                autoComplete="name"
                required
                disabled={!isHydrated || isAdding}
                className="min-h-11 sm:min-h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newUserEmail">Email address</Label>
              <Input
                id="newUserEmail"
                type="email"
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
                placeholder="samira@example.com"
                autoComplete="email"
                required
                disabled={!isHydrated || isAdding}
                aria-describedby="newUserEmail-help"
                className="min-h-11 sm:min-h-9"
              />
              <InlineHelp id="newUserEmail-help">
                The setup link is sent here and expires after first use.
              </InlineHelp>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="roleSelect">Role</Label>
            <Select
              value={selectedRoleId}
              onValueChange={setSelectedRoleId}
              disabled={!isHydrated || isAdding || !userAuthorityReady || isLoadingRoles || Boolean(rolesError)}
            >
              <SelectTrigger
                id="roleSelect"
                className="min-h-11 sm:min-h-9"
                aria-describedby="roleSelect-help"
              >
                <SelectValue placeholder={isLoadingRoles ? "Loading roles…" : "Select a role"} />
              </SelectTrigger>
              <SelectContent>
                {availableRoles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    <div className="flex flex-col">
                      <span>{role.displayName}</span>
                      {role.description && (
                        <span className="text-xs text-muted-foreground">{role.description}</span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {rolesError ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-background p-2">
                <FieldError id="roleSelect-help">{rolesError}</FieldError>
                <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={() => void refetchRoles()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  Retry
                </Button>
              </div>
            ) : availableRoles.length === 0 && !isLoadingRoles ? (
              <FieldError id="roleSelect-help">
                No assignable roles are available. {canManageRoles ? "Create a role in the Roles section first." : "Ask a role manager to create one."}
              </FieldError>
            ) : (
              <InlineHelp id="roleSelect-help">
                The role controls store access and can be changed later.
              </InlineHelp>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={resetInviteForm}
              disabled={isAdding}
              className="min-h-11 sm:min-h-9"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isHydrated || isAdding || !userAuthorityReady || !selectedRoleId || Boolean(rolesError) || availableRoles.length === 0}
              className="min-h-11 sm:min-h-9"
            >
              {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Send invite
            </Button>
          </div>
        </form>
      )}

      {usersError && adminUsers.length > 0 && (
        <Alert variant="destructive" className="mb-3">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{usersError} Showing the last loaded list.</span>
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={() => void refetch()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {adminUsers.length > 0 && (
        <IndexFilters
          className="mb-3"
          label="Find administrators"
          searchValue={query}
          onSearchChange={setQuery}
          searchPlaceholder="Find administrators"
          filters={statusPills}
          activeFilterId={statusFilter}
          onFilterChange={(id) => setStatusFilter(id as StatusFilterId)}
        />
      )}

      {usersError && adminUsers.length === 0 ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Administrators are unavailable</AlertTitle>
          <AlertDescription className="gap-2">
            <span>{usersError}</span>
            <Button type="button" size="sm" className="mt-1 min-h-11 sm:min-h-9" onClick={() => void refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : !showLoadingSkeleton && adminUsers.length === 0 ? (
        <EmptyState
          icon={Users}
          heading="No administrators found"
          body="Invite someone when this store needs shared access."
          action={
            canManageTeam
              ? {
                  label: "Invite administrator",
                  icon: UserPlus,
                  disabled: !userAuthorityReady,
                  onClick: () => setShowAddForm(true),
                }
              : undefined
          }
        />
      ) : noMatches ? (
        <EmptyState
          icon={Users}
          heading="No matching administrators"
          body="Change the search or pick another status."
          action={{ label: "Clear filters", variant: "outline", onClick: clearFilters }}
        />
      ) : (
        <div data-admin-list="active">
          <IndexTable
            label="Active administrators"
            items={filteredActiveUsers}
            columns={columns}
            getRowId={(adminUser) => adminUser.id}
            loading={showLoadingSkeleton}
            loadingRowCount={3}
            rowActions={renderRowActions}
            empty={
              <EmptyState
                compact
                icon={Users}
                heading={
                  hasFilter ? "No active administrators match" : "No active administrators"
                }
                body={
                  hasFilter
                    ? "Matches are in the Suspended section below."
                    : "Everyone here is suspended."
                }
              />
            }
          />
        </div>
      )}

      {suspendedUsers.length > 0 && !showLoadingSkeleton && (
        <details
          data-admin-list="suspended"
          className="group mt-4 rounded-lg border"
          open={showSuspendedOpen}
          onToggle={(event) => setSuspendedOpen(event.currentTarget.open)}
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2">
              <UserX className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Suspended
              <span
                data-testid="suspended-users-count"
                className="rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground"
              >
                {hasFilter ? `${filteredSuspendedUsers.length} of ${suspendedUsers.length}` : suspendedUsers.length}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="border-t p-3">
            <InlineHelp className="mb-3">
              Suspended administrators cannot sign in. Restore access to move them
              back to the list above.
            </InlineHelp>
            <IndexTable
              label="Suspended administrators"
              items={filteredSuspendedUsers}
              columns={columns}
              getRowId={(adminUser) => adminUser.id}
              rowActions={renderRowActions}
              empty={
                <EmptyState
                  compact
                  icon={UserX}
                  heading="No suspended administrators match this search."
                />
              }
            />
          </div>
        </details>
      )}

      <AlertDialog
        open={revokingInvite !== null}
        onOpenChange={(open) => {
          if (!open) setRevokingInvite(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{revokingInvite?.name}</strong> will no longer be able to use
              the setup link. You can invite them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-11 sm:min-h-9"
              onClick={() => {
                if (revokingInvite) void deleteUser(revokingInvite.id);
              }}
            >
              Revoke invitation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={suspendingUser !== null}
        onOpenChange={(open) => {
          if (!open) setSuspendingUser(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend administrator?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{suspendingUser?.name}</strong> will be signed out on every
              device and cannot sign in until access is restored. Their role and
              activity history stay intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9">Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-11 sm:min-h-9"
              onClick={() => {
                if (suspendingUser) void handleSuspension(suspendingUser, true);
              }}
            >
              Suspend access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editingUser && userAuthorityReady && (
        <UserPermissionEditor
          user={editingUser}
          isOpen={!!editingUser}
          onClose={() => setEditingUser(null)}
          onUpdate={refetch}
        />
      )}
    </SettingsSection>
  );
}

function AdminStatusBadge({
  status,
  invitation,
}: {
  status: AdminUserStatus;
  invitation: AdminUser["invitation"];
}) {
  const copy = ADMIN_USER_STATUS_COPY[status];
  const timing = status === "invite_pending"
    ? getInvitationTiming(invitation?.expiresAt)
    : null;
  const title = invitation?.expiresAt && status === "invite_pending"
    ? `Setup link expires ${new Date(invitation.expiresAt).toLocaleString(undefined, { timeZone: "Asia/Dhaka" })}.`
    : copy.description;

  return (
    <span title={title}>
      <StatusBadge tone={STATUS_TONES[status]} srLabel="Setup status:">
        {copy.label}
        {timing ? ` · ${timing}` : ""}
      </StatusBadge>
    </span>
  );
}
