// src/components/admin/RolesManagement.tsx
import { useState, useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
} from "@/components/ui/alert-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2,
  Plus,
  Shield,
  Pencil,
  Trash2,
  AlertTriangle,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/contexts/PermissionContext";
import { PermissionGate } from "./PermissionGate";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getServerFnError } from "@/lib/api-helpers";
import { refreshAdminRouteContext } from "@/lib/admin-route-context";
import {
  createRbacRole,
  deleteRbacRole,
  getRbacPermissions,
  getRbacRoles,
  updateRbacRole,
  type CreateRbacRoleInput,
  type RbacPermissionMetadata,
  type RbacRole,
  type UpdateRbacRoleInput,
} from "@/lib/api-functions/rbac";

type Role = RbacRole;
type PermissionMetadata = RbacPermissionMetadata;
type RoleUpdateInput = UpdateRbacRoleInput["update"];

interface GroupedPermissions {
  [category: string]: PermissionMetadata[];
}

export function RolesManagement() {
  const router = useRouter();
  const [roles, setRoles] = useState<Role[]>([]);
  const [groupedPermissions, setGroupedPermissions] = useState<GroupedPermissions>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const { hasPermission } = usePermissions();

  const canManageRoles = hasPermission(PERMISSIONS.TEAM_MANAGE_ROLES);

  const refreshPermissions = async () => {
    await refreshAdminRouteContext(router);
  };

  // Fetch roles and permissions
  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [rolesData, permsData] = await Promise.all([
          getRbacRoles(),
          getRbacPermissions(),
        ]);

        setRoles(rolesData.roles);
        setGroupedPermissions(permsData.grouped);
      } catch (error: unknown) {
        console.error("Error fetching RBAC data:", error);
        toast.error("Failed to load roles and permissions");
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, []);

  const handleCreateRole = async (roleData: CreateRbacRoleInput) => {
    try {
      const data = await createRbacRole({ data: roleData });
      setRoles((currentRoles) => [...currentRoles, data.role]);
      await refreshPermissions();
      toast.success("Role created successfully");
      return true;
    } catch (error: unknown) {
      console.error("Error creating role:", error);
      toast.error(getServerFnError(error, "Failed to create role"));
      return false;
    }
  };

  const handleUpdateRole = async (
    roleId: string,
    updates: RoleUpdateInput,
  ) => {
    try {
      const data = await updateRbacRole({ data: { roleId, update: updates } });
      setRoles((currentRoles) =>
        currentRoles.map((role) => (role.id === roleId ? data.role : role)),
      );
      await refreshPermissions();
      toast.success("Role updated successfully");
      return true;
    } catch (error: unknown) {
      console.error("Error updating role:", error);
      toast.error(getServerFnError(error, "Failed to update role"));
      return false;
    }
  };

  const handleDeleteRole = async (roleId: string) => {
    try {
      await deleteRbacRole({ data: { roleId } });
      setRoles((currentRoles) =>
        currentRoles.filter((role) => role.id !== roleId),
      );
      await refreshPermissions();
      toast.success("Role deleted successfully");
    } catch (error: unknown) {
      console.error("Error deleting role:", error);
      toast.error("An unexpected error occurred");
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Roles Management
            </CardTitle>
            <CardDescription>
              Create and manage roles with specific permissions
            </CardDescription>
          </div>
          <PermissionGate permission={PERMISSIONS.TEAM_MANAGE_ROLES}>
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Role
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                <RoleForm
                  groupedPermissions={groupedPermissions}
                  onSubmit={async (data) => {
                    const success = await handleCreateRole(data);
                    if (success) setIsCreateOpen(false);
                  }}
                  onCancel={() => setIsCreateOpen(false)}
                />
              </DialogContent>
            </Dialog>
          </PermissionGate>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {roles.map((role) => (
              <RoleCard
                key={role.id}
                role={role}
                canManage={canManageRoles}
                onEdit={() => setEditingRole(role)}
                onDelete={() => handleDeleteRole(role.id)}
              />
            ))}

            {roles.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No roles found. Create your first role to get started.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Edit Role Dialog */}
      {editingRole && (
        <Dialog open={!!editingRole} onOpenChange={() => setEditingRole(null)}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <RoleForm
              role={editingRole}
              groupedPermissions={groupedPermissions}
              onSubmit={async (data) => {
                const success = await handleUpdateRole(editingRole.id, {
                  displayName: data.displayName,
                  description: data.description,
                  permissions: data.permissions,
                });
                if (success) setEditingRole(null);
              }}
              onCancel={() => setEditingRole(null)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// Role Card Component
function RoleCard({
  role,
  canManage,
  onEdit,
  onDelete,
}: {
  role: Role;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const permissionCount = role.permissions.length;

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{role.displayName}</h3>
            {role.isSystem && (
              <Badge variant="secondary" className="text-xs">
                <Lock className="h-3 w-3 mr-1" />
                System
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {role.description || "No description"}
          </p>
          <p className="text-xs text-muted-foreground mt-2">
            {permissionCount} permission{permissionCount !== 1 ? "s" : ""}
          </p>
        </div>

        {canManage && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil className="h-4 w-4" />
            </Button>
            {!role.isSystem && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Role</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete the "{role.displayName}" role?
                      This action cannot be undone. Users with this role will lose
                      the associated permissions.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={onDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Role Form Component
function RoleForm({
  role,
  groupedPermissions,
  onSubmit,
  onCancel,
}: {
  role?: Role;
  groupedPermissions: GroupedPermissions;
  onSubmit: (data: CreateRbacRoleInput) => Promise<boolean | void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(role?.name || "");
  const [displayName, setDisplayName] = useState(role?.displayName || "");
  const [description, setDescription] = useState(role?.description || "");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(
    new Set(role?.permissions || [])
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEditing = !!role;
  const isSystemRole = role?.isSystem;

  const handlePermissionToggle = (permName: string) => {
    if (isSystemRole) return;

    const newSet = new Set(selectedPermissions);
    if (newSet.has(permName)) {
      newSet.delete(permName);
    } else {
      newSet.add(permName);
    }
    setSelectedPermissions(newSet);
  };

  const handleCategoryToggle = (category: string) => {
    if (isSystemRole) return;

    const categoryPerms = groupedPermissions[category]?.map((p) => p.name) || [];
    const allSelected = categoryPerms.every((p) => selectedPermissions.has(p));

    const newSet = new Set(selectedPermissions);
    if (allSelected) {
      categoryPerms.forEach((p) => newSet.delete(p));
    } else {
      categoryPerms.forEach((p) => newSet.add(p));
    }
    setSelectedPermissions(newSet);
  };

  const handleSubmit = async () => {
    if (!displayName.trim()) {
      toast.error("Display name is required");
      return;
    }

    if (!isEditing && !name.trim()) {
      toast.error("Role name is required");
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        name: name.toLowerCase().replace(/\s+/g, "_"),
        displayName: displayName.trim(),
        description: description.trim() || undefined,
        permissions: Array.from(selectedPermissions),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEditing ? "Edit Role" : "Create Role"}</DialogTitle>
        <DialogDescription>
          {isEditing
            ? isSystemRole
              ? "System roles have limited editing options."
              : "Modify the role's details and permissions."
            : "Create a new role with custom permissions."}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        {!isEditing && (
          <div className="space-y-2">
            <Label htmlFor="name">Role Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., inventory_manager"
              disabled={isEditing}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase, underscores allowed. Cannot be changed later.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="displayName">Display Name</Label>
          <Input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g., Inventory Manager"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe what this role is for..."
            rows={2}
          />
        </div>

        <div className="space-y-2">
          <Label>Permissions</Label>
          {isSystemRole && (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              System role permissions cannot be modified.
            </p>
          )}
          <Accordion type="multiple" className="w-full">
            {Object.entries(groupedPermissions).map(([category, perms]) => {
              const selectedInCategory = perms.filter((p) =>
                selectedPermissions.has(p.name)
              ).length;
              const allSelected = selectedInCategory === perms.length;

              return (
                <AccordionItem key={category} value={category}>
                  <AccordionTrigger className="hover:no-underline">
                    <div className="flex items-center justify-between w-full pr-4">
                      <span>{category}</span>
                      <Badge variant="secondary" className="ml-2">
                        {selectedInCategory}/{perms.length}
                      </Badge>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 pt-2">
                      {!isSystemRole && (
                        <div className="flex items-center gap-2 pb-2 border-b">
                          <Checkbox
                            id={`category-${category}`}
                            checked={allSelected}
                            onCheckedChange={() => handleCategoryToggle(category)}
                          />
                          <Label
                            htmlFor={`category-${category}`}
                            className="text-sm font-medium cursor-pointer"
                          >
                            Select All
                          </Label>
                        </div>
                      )}
                      {perms.map((perm) => (
                        <div
                          key={perm.name}
                          className="flex items-start gap-2 py-1"
                        >
                          <Checkbox
                            id={perm.name}
                            checked={selectedPermissions.has(perm.name)}
                            onCheckedChange={() =>
                              handlePermissionToggle(perm.name)
                            }
                            disabled={isSystemRole}
                          />
                          <div className="flex-1">
                            <Label
                              htmlFor={perm.name}
                              className="text-sm font-medium cursor-pointer flex items-center gap-2"
                            >
                              {perm.displayName}
                              {perm.isSensitive && (
                                <Badge variant="outline" className="text-xs">
                                  Sensitive
                                </Badge>
                              )}
                            </Label>
                            <p className="text-xs text-muted-foreground">
                              {perm.description}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {isEditing ? "Save Changes" : "Create Role"}
        </Button>
      </DialogFooter>
    </>
  );
}
