import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
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
  Search,
} from "lucide-react";
import { usePermissions } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
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

function getInitials(name: string): string {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
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
  } = useAdminUsers();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [resendingUserId, setResendingUserId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { hasPermission } = usePermissions();
  const canManageTeam = hasPermission(PERMISSIONS.TEAM_MANAGE);
  const canManageRoles = hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES);
  const isHydrated = useHydrated();
  const userAuthorityReady = isAdminUserAuthorityReady({
    isLoading,
    error: usersError,
  });
  const filteredUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return adminUsers;

    return adminUsers.filter((adminUser) =>
      [
        adminUser.name,
        adminUser.email,
        ...adminUser.roles.map((role) => role.displayName),
      ].some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }, [adminUsers, query]);

  const resetInviteForm = () => {
    setShowAddForm(false);
    setNewUserName("");
    setNewUserEmail("");
    setSelectedRoleId("");
    setError(null);
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

  return (
    <Card className="rounded-xl shadow-none">
      <CardHeader className="p-4 pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Administrators
              <span className="rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
                {adminUsers.length}
              </span>
            </CardTitle>
            <CardDescription>
              Invite people and review whether their secure setup is complete.
            </CardDescription>
          </div>
          {canManageTeam && (
            <Button
              size="sm"
              className="min-h-11 sm:min-h-9"
              onClick={() => setShowAddForm(true)}
              disabled={showAddForm || !userAuthorityReady}
            >
              <UserPlus className="mr-2 h-4 w-4" />
              Invite administrator
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
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
              <p className="mt-0.5 text-xs text-muted-foreground">
                They receive a one-use setup link and must configure a password and 2FA.
              </p>
            </div>
            {error && (
              <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-2">
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
              <div className="space-y-2">
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
                  className="min-h-11 sm:min-h-9"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="roleSelect">Role</Label>
              <Select
                value={selectedRoleId}
                onValueChange={setSelectedRoleId}
                disabled={!isHydrated || isAdding || !userAuthorityReady || isLoadingRoles || Boolean(rolesError)}
              >
                <SelectTrigger id="roleSelect" className="min-h-11 sm:min-h-9">
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
                <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-background p-2 text-xs">
                  <span className="text-destructive">{rolesError}</span>
                  <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={() => void refetchRoles()}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              ) : availableRoles.length === 0 && !isLoadingRoles ? (
                <p className="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive">
                  No assignable roles are available. {canManageRoles ? "Create a role in the Roles section first." : "Ask a role manager to create one."}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The role controls store access and can be changed later.
                </p>
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
                {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send invite
              </Button>
            </div>
          </form>
        )}

        {usersError && adminUsers.length > 0 && (
          <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span className="text-destructive">{usersError} Showing the last loaded list.</span>
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={() => void refetch()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        )}

        {adminUsers.length > 0 && (
          <div className="relative mb-3 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find name, email, or role…"
              aria-label="Find administrators"
              className="min-h-11 pl-9 sm:min-h-9"
            />
          </div>
        )}

        {isLoading && adminUsers.length === 0 ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading administrators">
            {[0, 1, 2].map((row) => (
              <div key={row} className="h-16 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : usersError && adminUsers.length === 0 ? (
          <div role="alert" className="rounded-lg border border-destructive/30 p-5">
            <div className="flex max-w-lg items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-semibold">Administrators are unavailable</p>
                <p className="mt-1 text-sm text-muted-foreground">{usersError}</p>
                <Button type="button" size="sm" className="mt-3 min-h-11 sm:min-h-9" onClick={() => void refetch()}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Retry
                </Button>
              </div>
            </div>
          </div>
        ) : adminUsers.length === 0 ? (
          <div className="rounded-lg border border-dashed py-10 text-center text-muted-foreground">
            <Users className="mx-auto mb-2 h-8 w-8 opacity-40" />
            <p className="text-sm font-medium text-foreground">No administrators found</p>
            <p className="mt-1 text-xs">Invite someone when this store needs shared access.</p>
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="rounded-lg border border-dashed py-8 text-center">
            <p className="text-sm font-medium">No matching administrators</p>
            <button type="button" onClick={() => setQuery("")} className="mt-1 min-h-9 px-3 text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Clear search
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <div className="hidden grid-cols-[minmax(0,1fr)_minmax(9rem,0.55fr)_auto] gap-3 border-b bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
              <span>Administrator</span>
              <span>Access</span>
              <span className="pr-1 text-right">Status and actions</span>
            </div>
            <div className="divide-y">
            {filteredUsers.map((adminUser) => {
              const status = getAdminUserStatus(adminUser);
              return (
              <div
                key={adminUser.id}
                className="grid gap-3 p-3 transition-colors hover:bg-muted/20 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.55fr)_auto] sm:items-center"
              >
                <div className="flex min-w-0 items-start gap-3 sm:items-center">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10">
                    {adminUser.image ? (
                      <img
                        src={getOptimizedImageUrl(
                          adminUser.image,
                          ADMIN_IMAGE_PRESETS.avatar,
                        )}
                        alt={adminUser.name}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="text-sm font-medium text-primary">{getInitials(adminUser.name)}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium">
                      <span className="truncate">{adminUser.name}</span>
                      {adminUser.id === currentUserId && (
                        <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                          You
                        </span>
                      )}
                      {adminUser.isSuperAdmin && (
                        <span className="text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 px-2 py-0.5 rounded-full">
                          Super Admin
                        </span>
                      )}
                    </p>
                    <p className="break-words text-sm text-muted-foreground">{adminUser.email}</p>
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap gap-1.5">
                  {adminUser.roles.length > 0 ? adminUser.roles.map((role) => (
                    <span key={role.id} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                      {role.displayName}
                    </span>
                  )) : (
                    <span className="text-xs text-muted-foreground">No assigned role</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <AdminStatusBadge status={status} />
                  {canManageTeam && status === "password_setup" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-h-11 text-xs sm:min-h-9"
                      onClick={() => void handleResendSetup(adminUser.id)}
                      disabled={!userAuthorityReady || resendingUserId !== null}
                    >
                      {resendingUserId === adminUser.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                      Resend setup
                    </Button>
                  )}
                  {canManageRoles && adminUser.id !== currentUserId && !adminUser.isSuperAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-h-11 text-xs sm:min-h-9"
                      onClick={() => setEditingUser(adminUser)}
                      disabled={!userAuthorityReady}
                    >
                      <Shield className="h-3 w-3 mr-1" />
                      Permissions
                    </Button>
                  )}
                  {canManageTeam && adminUser.id !== currentUserId && !adminUser.isSuperAdmin && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-11 w-11 text-muted-foreground hover:text-destructive sm:h-9 sm:w-9" aria-label={`Remove ${adminUser.name}`} disabled={!userAuthorityReady}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                        <AlertDialogTitle>Remove administrator?</AlertDialogTitle>
                          <AlertDialogDescription>
                            <strong>{adminUser.name}</strong> will lose admin access immediately. Their historical activity remains in the audit trail.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteUser(adminUser.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Remove access
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>
              );
            })}
            </div>
          </div>
        )}

        {editingUser && userAuthorityReady && (
          <UserPermissionEditor
            user={editingUser}
            isOpen={!!editingUser}
            onClose={() => setEditingUser(null)}
            onUpdate={refetch}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AdminStatusBadge({ status }: { status: AdminUserStatus }) {
  const copy = ADMIN_USER_STATUS_COPY[status];
  const ready = status === "ready";

  return (
    <span
      title={copy.description}
      className={`inline-flex min-h-7 items-center rounded-full border px-2 py-1 text-xs font-medium ${
        ready
          ? "border-primary/25 bg-primary/5 text-primary"
          : "border-destructive/25 bg-destructive/5 text-destructive"
      }`}
    >
      {copy.label}
    </span>
  );
}
