import { useState } from "react";
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
  ShieldCheck,
  UserPlus,
  Trash2,
  AlertCircle,
  Users,
} from "lucide-react";
import { usePermissions } from "~/contexts/PermissionContext";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { UserPermissionEditor } from "../UserPermissionEditor";
import { useAdminUsers, type AdminUser } from "./hooks/useAdminUsers";

function getInitials(name: string): string {
  return name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);
}

interface AdminUsersManagerProps {
  currentUserId: string;
}

export function AdminUsersManager({ currentUserId }: AdminUsersManagerProps) {
  const { adminUsers, availableRoles, isLoading, addUser, deleteUser, refetch } = useAdminUsers();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const { hasPermission } = usePermissions();
  const canManageTeam = hasPermission(PERMISSIONS.TEAM_MANAGE);
  const canManageRoles = hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES);

  const handleAddUser = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setError(null);
    setIsAdding(true);

    try {
      await addUser(newUserName, newUserEmail, selectedRoleId);
      setShowAddForm(false);
      setNewUserName("");
      setNewUserEmail("");
      setSelectedRoleId("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Team Members
            </CardTitle>
            <CardDescription>
              Manage administrator access to your store
            </CardDescription>
          </div>
          {canManageTeam && (
            <Button onClick={() => setShowAddForm(true)} disabled={showAddForm}>
              <UserPlus className="h-4 w-4 mr-2" />
              Add Member
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {canManageTeam && showAddForm && (
          <form onSubmit={handleAddUser} className="mb-6 p-5 bg-muted/30 rounded-xl border space-y-4">
            <h4 className="font-medium">Invite New Team Member</h4>
            {error && (
              <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="newUserName">Full Name</Label>
                <Input
                  id="newUserName"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="John Doe"
                  required
                  disabled={isAdding}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="newUserEmail">Email Address</Label>
                <Input
                  id="newUserEmail"
                  type="email"
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder="john@example.com"
                  required
                  disabled={isAdding}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="roleSelect">Role</Label>
              <Select
                value={selectedRoleId}
                onValueChange={setSelectedRoleId}
                disabled={isAdding}
              >
                <SelectTrigger id="roleSelect">
                  <SelectValue placeholder="Select a role for this user" />
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
              <p className="text-xs text-muted-foreground">
                The role determines what this user can access. You can change it later.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              A temporary password will be sent to their email. They'll be required to set up 2FA on first login.
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={isAdding || !selectedRoleId}>
                {isAdding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send Invite
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => { setShowAddForm(false); setNewUserName(""); setNewUserEmail(""); setSelectedRoleId(""); setError(null); }}
                disabled={isAdding}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : adminUsers.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-3 opacity-20" />
            <p>No team members found</p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-xl border overflow-hidden">
            {adminUsers.map((adminUser) => (
              <div
                key={adminUser.id}
                className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                    {adminUser.image ? (
                      <img src={adminUser.image} alt={adminUser.name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-sm font-medium text-primary">{getInitials(adminUser.name)}</span>
                    )}
                  </div>
                  <div>
                    <p className="font-medium flex items-center gap-2">
                      {adminUser.name}
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
                    <p className="text-sm text-muted-foreground">{adminUser.email}</p>
                    {adminUser.roles && adminUser.roles.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {adminUser.roles.map((role) => (
                          <span
                            key={role.id}
                            className="text-xs bg-muted px-2 py-0.5 rounded"
                          >
                            {role.displayName}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {adminUser.twoFactorEnabled ? (
                    <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-50 dark:bg-green-900/30 dark:text-green-400 px-2 py-1 rounded-full">
                      <ShieldCheck className="h-3 w-3" />
                      2FA
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs font-medium text-amber-600 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400 px-2 py-1 rounded-full">
                      <AlertCircle className="h-3 w-3" />
                      No 2FA
                    </span>
                  )}
                  {canManageRoles && adminUser.id !== currentUserId && !adminUser.isSuperAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setEditingUser(adminUser)}
                    >
                      <Shield className="h-3 w-3 mr-1" />
                      Permissions
                    </Button>
                  )}
                  {canManageTeam && adminUser.id !== currentUserId && !adminUser.isSuperAdmin && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove Team Member</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to remove <strong>{adminUser.name}</strong> from the team? They will lose access to the admin dashboard immediately.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => deleteUser(adminUser.id)}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {editingUser && (
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
