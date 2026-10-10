// Registries and trusted developers. Everyone with access to Apps sees them;
// only a Super Admin changes them (a trusted developer's apps install without
// further questions). The official registry and key are pinned in the code and
// shown read-only. A save sends the revision the dialog showed.
import { useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Field } from "~/components/ui/field";
import { Skeleton } from "~/components/ui/skeleton";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { appsLifecycleMessages } from "~/i18n/apps-lifecycle";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import {
  appErrorMessage,
  appRegistrySettingsQueryOptions,
  registryIdFor,
  saveRegistrySettings,
  type AppRegistrySettings,
} from "~/lib/api-query-options/apps-lifecycle";
import { toast } from "~/lib/toast";

interface RegistryRow {
  uid: number;
  /** Null until saved: the id is made from the name when the list is sent. */
  id: string | null;
  name: string;
  indexUrl: string;
}

interface KeyRow {
  uid: number;
  keyId: string | null;
  name: string;
  publicKey: string;
}

type RowErrors = Record<string, "nameRequired" | "urlInvalid" | "keyInvalid">;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/** A base64 Ed25519 public key is 44 characters; the API accepts 40 to 64. */
const looksLikeKey = (value: string) => /^[A-Za-z0-9+/_-]{40,64}={0,2}$/.test(value.trim());

function SettingsForm({ settings, canEdit, onClose }: { settings: AppRegistrySettings; canEdit: boolean; onClose: () => void }) {
  const t = useMessages(appsLifecycleMessages);
  const queryClient = useQueryClient();
  const base = useId();
  const next = useRef(0);
  const uid = () => (next.current += 1);
  const [registries, setRegistries] = useState<RegistryRow[]>(() =>
    settings.registries.map((registry) => ({ uid: uid(), id: registry.id, name: registry.name, indexUrl: registry.indexUrl })),
  );
  const [keys, setKeys] = useState<KeyRow[]>(() =>
    settings.trustedKeys.filter((key) => !key.official).map((key) => ({ uid: uid(), keyId: key.id, name: key.name, publicKey: key.publicKey })),
  );
  const official = settings.trustedKeys.filter((key) => key.official);
  const [errors, setErrors] = useState<RowErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const taken = new Set(registries.flatMap((registry) => (registry.id ? [registry.id] : [])));
      const list = registries.map((registry) => {
        const id = registry.id ?? registryIdFor(registry.name, taken);
        taken.add(id);
        return { id, name: registry.name.trim(), indexUrl: registry.indexUrl.trim() };
      });
      return saveRegistrySettings(settings.revision, list, keys.map((key) => ({ name: key.name.trim(), publicKey: key.publicKey.trim() })));
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(appRegistrySettingsQueryOptions().queryKey, saved);
      // The browse list and which developers an app shows as verified depend on these.
      void queryClient.invalidateQueries({ queryKey: ["apps", "registry"] });
      toast.success(t("registriesSaved"));
      onClose();
    },
    onError: (error) => {
      if (isAdminApiConflictError(error)) {
        setFailure(t("registriesChanged"));
        return;
      }
      setFailure(appErrorMessage(error) ?? t("registriesSaveFailed"));
    },
  });

  const submit = () => {
    const found: RowErrors = {};
    for (const registry of registries) {
      if (!registry.name.trim()) found[`r${registry.uid}.name`] = "nameRequired";
      if (!isHttpsUrl(registry.indexUrl)) found[`r${registry.uid}.url`] = "urlInvalid";
    }
    for (const key of keys) {
      if (!key.name.trim()) found[`k${key.uid}.name`] = "nameRequired";
      if (!looksLikeKey(key.publicKey)) found[`k${key.uid}.key`] = "keyInvalid";
    }
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length === 0) save.mutate();
  };

  const field = (id: string, label: string, value: string, onChange: (value: string) => void, error: RowErrors[string] | undefined, mono = false) => (
    <Field id={`${base}-${id}`} label={label} error={error ? t(error) : undefined}>
      <Input
        value={value}
        disabled={save.isPending}
        autoComplete="off"
        spellCheck={false}
        // eslint-disable-next-line shadcn/no-restyle -- a pasted key is read as code
        className={mono ? "font-mono" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );

  return (
    <>
      <div className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-body font-medium">{t("registriesHeading")}</h3>
          <ul className="space-y-3">
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-body">
              <span className="font-medium">{t("officialRegistry")}</span>
              <Badge variant={settings.officialConfigured ? "success" : "secondary"}>{t(settings.officialConfigured ? "officialSet" : "officialNotSet")}</Badge>
            </li>
            {registries.map((registry) => (
              <li key={registry.uid} className="rounded-lg border border-border p-3">
                {canEdit ? (
                  <div className="flex items-start gap-2">
                    <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                      {field(`r${registry.uid}-name`, t("registryName"), registry.name, (value) => setRegistries((rows) => rows.map((row) => (row.uid === registry.uid ? { ...row, name: value } : row))), errors[`r${registry.uid}.name`])}
                      {field(`r${registry.uid}-url`, t("registryUrl"), registry.indexUrl, (value) => setRegistries((rows) => rows.map((row) => (row.uid === registry.uid ? { ...row, indexUrl: value } : row))), errors[`r${registry.uid}.url`])}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-6"
                      disabled={save.isPending}
                      aria-label={t("removeRegistry", { name: registry.name || t("registryName") })}
                      onClick={() => setRegistries((rows) => rows.filter((row) => row.uid !== registry.uid))}
                    >
                      {t("remove")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5 text-body">
                    <span className="font-medium">{registry.name}</span>
                    <span className="break-all text-muted-foreground">{registry.indexUrl}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {registries.length === 0 ? <p className="text-body text-muted-foreground">{t("noRegistries")}</p> : null}
          {canEdit ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => setRegistries((rows) => [...rows, { uid: uid(), id: null, name: "", indexUrl: "https://" }])}
            >
              {t("addRegistry")}
            </Button>
          ) : null}
        </section>

        <section className="space-y-3">
          <h3 className="text-body font-medium">{t("developersHeading")}</h3>
          <ul className="space-y-3">
            {official.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-body">
                <span className="font-medium">{t("officialDeveloper")}</span>
                <code>{key.id}</code>
              </li>
            ))}
            {keys.map((key) => (
              <li key={key.uid} className="rounded-lg border border-border p-3">
                {canEdit ? (
                  <div className="flex items-start gap-2">
                    <div className="grid min-w-0 flex-1 gap-3">
                      {field(`k${key.uid}-name`, t("developerName"), key.name, (value) => setKeys((rows) => rows.map((row) => (row.uid === key.uid ? { ...row, name: value } : row))), errors[`k${key.uid}.name`])}
                      {field(`k${key.uid}-key`, t("developerKey"), key.publicKey, (value) => setKeys((rows) => rows.map((row) => (row.uid === key.uid ? { ...row, publicKey: value } : row))), errors[`k${key.uid}.key`], true)}
                      {key.keyId ? <p className="text-body text-muted-foreground">{t("developerKeyId", { id: key.keyId })}</p> : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-6"
                      disabled={save.isPending}
                      aria-label={t("removeDeveloper", { name: key.name || t("developerName") })}
                      onClick={() => setKeys((rows) => rows.filter((row) => row.uid !== key.uid))}
                    >
                      {t("remove")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5 text-body">
                    <span className="font-medium">{key.name}</span>
                    {key.keyId ? <span className="text-muted-foreground">{t("developerKeyId", { id: key.keyId })}</span> : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {keys.length === 0 ? <p className="text-body text-muted-foreground">{t("noDevelopers")}</p> : null}
          {canEdit ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => setKeys((rows) => [...rows, { uid: uid(), keyId: null, name: "", publicKey: "" }])}
            >
              {t("addDeveloper")}
            </Button>
          ) : null}
        </section>
        {canEdit ? null : <p className="text-body text-muted-foreground">{t("readOnlyNote")}</p>}
        {failure ? <p role="alert" className="text-body text-destructive">{failure}</p> : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>{t(canEdit ? "cancel" : "close")}</Button>
        {canEdit ? <Button type="button" loading={save.isPending} onClick={submit}>{t("save")}</Button> : null}
      </DialogFooter>
    </>
  );
}

export function RegistrySettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(appsLifecycleMessages);
  const { isSuperAdmin } = usePermissions();
  const { data, isError, isRefetching, refetch } = useQuery({ ...appRegistrySettingsQueryOptions(), enabled: open });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("registrySettings")}</DialogTitle>
          <DialogDescription>{t("registriesIntro")}</DialogDescription>
        </DialogHeader>
        {data ? (
          // A fresh revision (after a conflict) starts the form over from what the store holds now.
          <SettingsForm key={data.revision} settings={data} canEdit={isSuperAdmin} onClose={() => onOpenChange(false)} />
        ) : isError ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-body text-destructive">{t("registriesLoadFailed")}</p>
            <Button type="button" variant="outline" size="sm" loading={isRefetching} onClick={() => void refetch()}>{t("tryAgain")}</Button>
          </div>
        ) : (
          <div aria-busy className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
