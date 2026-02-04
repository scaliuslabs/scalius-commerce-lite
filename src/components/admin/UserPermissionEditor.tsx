// src/components/admin/UserPermissionEditor.tsx
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Shield, AlertTriangle, Crown, Plus, X } from "lucide-react";
import { toast } from "sonner";

interface Role {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

interface PermissionMetadata {
  name: string;
  displayName: string;
  description: string;
  category: string;
  isSensitive: boolean;
}

interface GroupedPermissions {
  [category: string]: PermissionMetadata[];
}

interface UserWithRoles {
  id: string;
  name: string;
  email: string;
  isSuperAdmin?: boolean | null;
  roles: { id: string; name: string; displayName: string }[];
  overrides: {
    grants: string[];
    denials: string[];
  };
}

interface UserPermissionEditorProps {
  user: UserWithRoles;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

export function UserPermissionEditor({
  user,
  isOpen,
  onClose,
  onUpdate,
}: UserPermissionEditorProps) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [groupedPermissions, setGroupedPermissions] = useState<GroupedPermissions>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Local state for editing
  const [assignedRoleIds, setAssignedRoleIds] = useState<Set<string>>(
    new Set(user.roles.map((r) => r.id))
  );
  const [permissionOverrides, setPermissionOverrides] = useState<{
    grants: Set<string>;
    denials: Set<string>;
  }>({
    grants: new Set(user.overrides.grants),
    denials: new Set(user.overrides.denials),
  });

  // Fetch roles and permissions
  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const [rolesRes, permsRes] = await Promise.all([
          fetch("/api/admin/rbac/roles"),
          fetch("/api/admin/rbac/permissions"),
        ]);

        if (rolesRes.ok) {
          const data = await rolesRes.json();
          setRoles(data.roles);
        }

        if (permsRes.ok) {
          const data = await permsRes.json();
          setGroupedPermissions(data.grouped);
        }
      } catch (error) {
        console.error("Error fetching RBAC data:", error);
        toast.error("Failed to load roles and permissions");
      } finally {
        setIsLoading(false);
      }
    }

    if (isOpen) {
      fetchData();
      // Reset state when opening
      setAssignedRoleIds(new Set(user.roles.map((r) => r.id)));
      setPermissionOverrides({
        grants: new Set(user.overrides.grants),
        denials: new Set(user.overrides.denials),
      });
    }
  }, [isOpen, user]);

  // Calculate effective permissions from roles
  const rolePermissions = new Set<string>();
  roles
    .filter((r) => assignedRoleIds.has(r.id))
    .forEach((r) => r.permissions.forEach((p) => rolePermissions.add(p)));

  const handleAddRole = async (roleId: string) => {
    try {
      const response = await fetch("/api/admin/rbac/user-roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, roleId }),
      });

      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to assign role");
        return;
      }

      setAssignedRoleIds((prev) => new Set([...prev, roleId]));
      toast.success("Role assigned successfully");
    } catch (error) {
      console.error("Error assigning role:", error);
      toast.error("An unexpected error occurred");
    }
  };

  const handleRemoveRole = async (roleId: string) => {
    try {
      const response = await fetch("/api/admin/rbac/user-roles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, roleId }),
      });

      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to remove role");
        return;
      }

      setAssignedRoleIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(roleId);
        return newSet;
      });
      toast.success("Role removed successfully");
    } catch (error) {
      console.error("Error removing role:", error);
      toast.error("An unexpected error occurred");
    }
  };

  const handleSetOverride = async (permission: string, granted: boolean) => {
    try {
      const response = await fetch("/api/admin/rbac/user-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, permission, granted }),
      });

      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to set permission");
        return;
      }

      setPermissionOverrides((prev) => {
        const grants = new Set(prev.grants);
        const denials = new Set(prev.denials);

        // Remove from both first
        grants.delete(permission);
        denials.delete(permission);

        // Add to appropriate set
        if (granted) {
          grants.add(permission);
        } else {
          denials.add(permission);
        }

        return { grants, denials };
      });

      toast.success("Permission override set");
    } catch (error) {
      console.error("Error setting permission:", error);
      toast.error("An unexpected error occurred");
    }
  };

  const handleRemoveOverride = async (permission: string) => {
    try {
      const response = await fetch("/api/admin/rbac/user-permissions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, permission }),
      });

      if (!response.ok) {
        const data = await response.json();
        toast.error(data.error || "Failed to remove override");
        return;
      }

      setPermissionOverrides((prev) => {
        const grants = new Set(prev.grants);
        const denials = new Set(prev.denials);
        grants.delete(permission);
        denials.delete(permission);
        return { grants, denials };
      });

      toast.success("Permission override removed");
    } catch (error) {
      console.error("Error removing override:", error);
      toast.error("An unexpected error occurred");
    }
  };

  const getPermissionStatus = (permName: string): "inherit" | "grant" | "deny" => {
    if (permissionOverrides.grants.has(permName)) return "grant";
    if (permissionOverrides.denials.has(permName)) return "deny";
    return "inherit";
  };

  const isEffectivelyGranted = (permName: string): boolean => {
    const status = getPermissionStatus(permName);
    if (status === "grant") return true;
    if (status === "deny") return false;
    return rolePermissions.has(permName);
  };

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Edit Permissions: {user.name}
          </DialogTitle>
          <DialogDescription>
            Manage roles and permission overrides for {user.email}
          </DialogDescription>
        </DialogHeader>

        {user.isSuperAdmin && (
          <div className="flex items-center gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <Crown className="h-5 w-5 text-amber-500" />
            <div>
              <p className="font-medium text-amber-600">Super Admin</p>
              <p className="text-sm text-muted-foreground">
                This user has all permissions and cannot be modified.
              </p>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs defaultValue="roles" className="mt-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="roles">Roles</TabsTrigger>
              <TabsTrigger value="overrides">Permission Overrides</TabsTrigger>
            </TabsList>

            <TabsContent value="roles" className="space-y-4 mt-4">
              {/* Assigned Roles */}
              <div className="space-y-2">
                <Label>Assigned Roles</Label>
                <div className="flex flex-wrap gap-2">
                  {roles
                    .filter((r) => assignedRoleIds.has(r.id))
                    .map((role) => (
                      <Badge
                        key={role.id}
                        variant="secondary"
                        className="flex items-center gap-1 py-1"
                      >
                        {role.displayName}
                        {!user.isSuperAdmin && (
                          <button
                            onClick={() => handleRemoveRole(role.id)}
                            className="ml-1 hover:text-destructive"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </Badge>
                    ))}
                  {assignedRoleIds.size === 0 && (
                    <span className="text-sm text-muted-foreground">
                      No roles assigned
                    </span>
                  )}
                </div>
              </div>

              {/* Add Role */}
              {!user.isSuperAdmin && (
                <div className="space-y-2">
                  <Label>Add Role</Label>
                  <Select onValueChange={(value) => handleAddRole(value)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a role to add" />
                    </SelectTrigger>
                    <SelectContent>
                      {roles
                        .filter((r) => !assignedRoleIds.has(r.id))
                        .map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {role.displayName}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Role Permissions Preview */}
              <div className="space-y-2 pt-4">
                <Label>Permissions from Roles</Label>
                <p className="text-sm text-muted-foreground">
                  {rolePermissions.size} permission
                  {rolePermissions.size !== 1 ? "s" : ""} granted through roles
                </p>
              </div>
            </TabsContent>

            <TabsContent value="overrides" className="space-y-4 mt-4">
              {user.isSuperAdmin ? (
                <div className="text-center py-8 text-muted-foreground">
                  Super admins cannot have permission overrides.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                    <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Overrides take precedence over role permissions. Use sparingly.
                    </p>
                  </div>

                  <Accordion type="multiple" className="w-full">
                    {Object.entries(groupedPermissions).map(
                      ([category, perms]) => (
                        <AccordionItem key={category} value={category}>
                          <AccordionTrigger className="hover:no-underline">
                            <span>{category}</span>
                          </AccordionTrigger>
                          <AccordionContent>
                            <div className="space-y-2 pt-2">
                              {perms.map((perm) => {
                                const status = getPermissionStatus(perm.name);
                                const effective = isEffectivelyGranted(
                                  perm.name
                                );
                                const fromRole = rolePermissions.has(perm.name);

                                return (
                                  <div
                                    key={perm.name}
                                    className="flex items-center justify-between py-2 px-2 rounded hover:bg-muted/50"
                                  >
                                    <div className="flex-1">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium">
                                          {perm.displayName}
                                        </span>
                                        {perm.isSensitive && (
                                          <Badge
                                            variant="outline"
                                            className="text-xs"
                                          >
                                            Sensitive
                                          </Badge>
                                        )}
                                        {status === "inherit" && fromRole && (
                                          <Badge
                                            variant="secondary"
                                            className="text-xs"
                                          >
                                            From role
                                          </Badge>
                                        )}
                                      </div>
                                      <p className="text-xs text-muted-foreground">
                                        {perm.description}
                                      </p>
                                    </div>

                                    <div className="flex items-center gap-2">
                                      {/* Status indicator */}
                                      <Badge
                                        variant={
                                          effective ? "default" : "outline"
                                        }
                                        className={
                                          effective
                                            ? "bg-green-500/10 text-green-600 border-green-500/20"
                                            : "bg-red-500/10 text-red-600 border-red-500/20"
                                        }
                                      >
                                        {effective ? "Granted" : "Denied"}
                                      </Badge>

                                      {/* Override controls */}
                                      <Select
                                        value={status}
                                        onValueChange={(value) => {
                                          if (value === "inherit") {
                                            handleRemoveOverride(perm.name);
                                          } else {
                                            handleSetOverride(
                                              perm.name,
                                              value === "grant"
                                            );
                                          }
                                        }}
                                      >
                                        <SelectTrigger className="w-[130px] h-8">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="inherit">
                                            Inherit
                                          </SelectItem>
                                          <SelectItem value="grant">
                                            Force Grant
                                          </SelectItem>
                                          <SelectItem value="deny">
                                            Force Deny
                                          </SelectItem>
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      )
                    )}
                  </Accordion>
                </>
              )}
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onUpdate();
              onClose();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
