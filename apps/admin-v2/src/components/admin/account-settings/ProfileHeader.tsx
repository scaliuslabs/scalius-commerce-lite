import { useEffect, useRef, useState } from "react";
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
  const currentUserIdRef = useRef(user.id);
  const isEditingRef = useRef(false);
  const [savedName, setSavedName] = useState(user.name);
  const [savedImage, setSavedImage] = useState(user.image || "");
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image || "");
  const [isLoading, setIsLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  useEffect(() => {
    const nextSavedName = user.name;
    const nextSavedImage = user.image || "";
    const isDifferentUser = currentUserIdRef.current !== user.id;

    currentUserIdRef.current = user.id;
    setSavedName(nextSavedName);
    setSavedImage(nextSavedImage);

    if (isDifferentUser || !isEditingRef.current) {
      setName(nextSavedName);
      setImage(nextSavedImage);
      if (isDifferentUser) setIsEditing(false);
    }
  }, [user.id, user.name, user.image]);

  const normalizedName = name.trim();
  const hasChanges = normalizedName !== savedName || image !== savedImage;

  const handleImageSelect = (file: MediaFile) => {
    setImage(file.url);
    setIsEditing(true);
  };

  const removeImage = () => {
    setImage("");
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (normalizedName.length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }

    setIsLoading(true);

    try {
      const result = await updateProfile({
        data: { name: normalizedName, image: image || null },
      });
      const updatedName = result.user?.name ?? normalizedName;
      const updatedImage =
        result.user?.image === undefined ? image || "" : result.user.image || "";

      toast.success("Profile updated successfully");
      setSavedName(updatedName);
      setSavedImage(updatedImage);
      setName(updatedName);
      setImage(updatedImage);
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

  return (
    <Card className="rounded-xl shadow-none">
      <CardContent className="p-4">
        <div className="grid gap-3 sm:grid-cols-[72px_minmax(0,1fr)] sm:items-center">
          {/* Avatar */}
          <div className="relative h-16 w-16">
            <div className="h-16 w-16 overflow-hidden rounded-full border bg-muted">
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
                  <span className="text-lg font-semibold text-primary">
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
                className="absolute -bottom-1 -right-1 h-8 w-8 rounded-full"
                onClick={removeImage}
                title="Remove photo"
                aria-label="Remove profile photo"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          {/* User Info */}
          <div className="min-w-0 space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1 space-y-1.5">
                {isEditing ? (
                  <Input
                    id="profile-display-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !isLoading && hasChanges) {
                        event.preventDefault();
                        void handleSave();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        handleCancel();
                      }
                    }}
                    className="h-10 max-w-xl text-base font-semibold"
                    placeholder="Display name"
                    aria-label="Display name"
                    autoFocus
                  />
                ) : (
                  <h2 className="truncate text-base font-semibold">{name}</h2>
                )}
                <p className="break-all text-sm text-muted-foreground">{user.email}</p>
              </div>

              <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                {user.role === "admin" && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium bg-primary/10 text-primary px-2.5 py-1 rounded-full">
                    <Shield className="h-3 w-3" />
                    Admin
                  </span>
                )}
                {user.twoFactorEnabled && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                    <ShieldCheck className="h-3 w-3" />
                    2FA
                  </span>
                )}
                <div
                  className="flex min-h-10 flex-wrap items-center gap-2"
                  data-profile-edit-actions
                >
                  {!isEditing ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-10 sm:min-h-8"
                      onClick={() => setIsEditing(true)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit profile
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="min-h-10 sm:min-h-8"
                        onClick={handleCancel}
                        disabled={isLoading}
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="min-h-10 sm:min-h-8"
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

            {/* Actions */}
            <div className="flex min-h-10 flex-wrap items-center gap-2 border-t pt-3 sm:border-t-0 sm:pt-0">
              <MediaManager
                capability="image"
                onSelect={handleImageSelect}
                triggerLabel={image ? "Change Photo" : "Add Photo"}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-10 shrink-0 shadow-none after:shadow-none sm:min-h-8"
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
                  className="min-h-10 text-destructive hover:text-destructive sm:min-h-8"
                  onClick={removeImage}
                  disabled={isLoading}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
