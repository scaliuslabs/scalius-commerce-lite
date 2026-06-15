import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Card, CardContent } from "~/components/ui/card";
import { Loader2, Shield, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { MediaManager, type MediaFile } from "../media-manager";
import type { User } from "./AccountSettingsContainer";
import { useRouter } from "@tanstack/react-router";
import { getServerFnError } from "~/lib/api-helpers";
import { updateProfile } from "~/lib/api-functions/auth-management";
import { refreshAdminRouteContext } from "~/lib/admin-route-context";

function getInitials(nameStr: string): string {
  return nameStr
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

interface ProfileHeaderProps {
  user: User;
}

export function ProfileHeader({ user }: ProfileHeaderProps) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image || "");
  const [isLoading, setIsLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const handleImageSelect = (file: MediaFile) => {
    setImage(file.url);
    setIsEditing(true);
  };

  const removeImage = () => {
    setImage("");
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (name.trim().length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }

    setIsLoading(true);

    try {
      await updateProfile({ data: { name: name.trim(), image: image || null } });
      toast.success("Profile updated successfully");
      setIsEditing(false);
      // Refresh to update header with updated user info
      void refreshAdminRouteContext(router);
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to update profile"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setName(user.name);
    setImage(user.image || "");
    setIsEditing(false);
  };

  const hasChanges = name !== user.name || image !== (user.image || "");

  return (
    <Card className="overflow-hidden">
      <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent h-24" />
      <CardContent className="relative pt-0 pb-6">
        <div className="flex flex-col sm:flex-row gap-6 items-start sm:items-end -mt-12">
          {/* Avatar */}
          <div className="relative group">
            <div className="h-24 w-24 rounded-full border-4 border-background bg-muted shadow-lg overflow-hidden">
              {image ? (
                <img
                  src={image}
                  alt={name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center bg-primary/10">
                  <span className="text-2xl font-semibold text-primary">
                    {getInitials(name)}
                  </span>
                </div>
              )}
            </div>
            {image && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={removeImage}
                title="Remove photo"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {/* User Info */}
          <div className="flex-1 space-y-4 pt-2 sm:pt-0">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1 space-y-1">
                {isEditing ? (
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="text-lg font-semibold h-auto py-1 px-2 -ml-2"
                    placeholder="Your name"
                  />
                ) : (
                  <h2 className="text-xl font-semibold">{name}</h2>
                )}
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </div>

              <div className="flex items-center gap-2">
                {user.role === "admin" && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium bg-primary/10 text-primary px-2.5 py-1 rounded-full">
                    <Shield className="h-3 w-3" />
                    Admin
                  </span>
                )}
                {user.twoFactorEnabled && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-2.5 py-1 rounded-full">
                    <ShieldCheck className="h-3 w-3" />
                    2FA
                  </span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <MediaManager
                onSelect={handleImageSelect}
                triggerLabel={image ? "Change Photo" : "Add Photo"}
              />
              {!isEditing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditing(true)}
                >
                  Edit Profile
                </Button>
              )}
              {isEditing && hasChanges && (
                <>
                  <Button size="sm" onClick={handleSave} disabled={isLoading}>
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : null}
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCancel}
                    disabled={isLoading}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
