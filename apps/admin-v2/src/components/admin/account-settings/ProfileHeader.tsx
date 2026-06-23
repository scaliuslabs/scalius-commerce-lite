import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Card, CardContent } from "~/components/ui/card";
import {
  Check,
  Loader2,
  Pencil,
  Shield,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
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
  const [savedName, setSavedName] = useState(user.name);
  const [savedImage, setSavedImage] = useState(user.image || "");
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image || "");
  const [isLoading, setIsLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    setSavedName(user.name);
    setSavedImage(user.image || "");
    setName(user.name);
    setImage(user.image || "");
  }, [user.id, user.name, user.image]);

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
      setSavedName(name.trim());
      setSavedImage(image || "");
      setName(name.trim());
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
    setName(savedName);
    setImage(savedImage);
    setIsEditing(false);
  };

  const hasChanges = name.trim() !== savedName || image !== savedImage;

  return (
    <Card className="overflow-hidden rounded-lg shadow-sm">
      <div className="h-16 border-b bg-[linear-gradient(135deg,hsl(var(--primary)/0.12),hsl(var(--muted)/0.28)_52%,transparent)]" />
      <CardContent className="relative px-4 pb-5 pt-0 sm:px-5">
        <div className="grid gap-4 sm:grid-cols-[104px_minmax(0,1fr)]">
          {/* Avatar */}
          <div className="relative -mt-10 h-24 w-24">
            <div className="h-24 w-24 overflow-hidden rounded-full border-4 border-background bg-muted shadow-lg">
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
            {image && isEditing && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full shadow-md"
                onClick={removeImage}
                title="Remove photo"
                aria-label="Remove profile photo"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {/* User Info */}
          <div className="-mt-1 min-w-0 space-y-4 sm:mt-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1 space-y-1.5">
                {isEditing ? (
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-10 max-w-xl text-lg font-semibold"
                    placeholder="Your name"
                    aria-label="Display name"
                    autoFocus
                  />
                ) : (
                  <h2 className="truncate text-xl font-semibold">{name}</h2>
                )}
                <p className="truncate text-sm text-muted-foreground">{user.email}</p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
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
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <MediaManager
                  onSelect={handleImageSelect}
                  triggerLabel={image ? "Change Photo" : "Add Photo"}
                  trigger={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 shrink-0 shadow-none after:shadow-none"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {image ? "Change photo" : "Add photo"}
                    </Button>
                  }
                />
                {image && isEditing && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-destructive hover:text-destructive"
                    onClick={removeImage}
                    disabled={isLoading}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </Button>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {!isEditing && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => setIsEditing(true)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit profile
                  </Button>
                )}
                {isEditing && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8"
                      onClick={handleCancel}
                      disabled={isLoading}
                    >
                      <X className="h-3.5 w-3.5" />
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8"
                      onClick={handleSave}
                      disabled={isLoading || !hasChanges}
                    >
                      {isLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-1" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Save changes
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
