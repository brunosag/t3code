import {
  type EnvironmentId,
  type UnifiedSettings,
  USAGE_ACCOUNT_IMAGE_MAX_LENGTH,
  type UsageLimitSourceAccount,
  type UsageLimitSourceAccountProfile,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AccountChip } from "../usage/AccountChip";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  cursorKeychainUsageEnabled,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly cursorKeychainUsageEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const platform = serverConfig?.environment.platform;
  const [adding, setAdding] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const entries = Object.entries(sources);

  const saveProfile = (
    id: string,
    source: UsageLimitSourceConfig,
    accountId: string,
    profile: UsageLimitSourceAccountProfile,
  ) => {
    const accounts = Object.fromEntries(
      Object.entries(source.accounts ?? {}).filter(([candidate]) => candidate !== accountId),
    );
    if (profile.name || profile.image) accounts[accountId] = profile;
    // The redacted management key round-trips as a marker, so the stored key is kept.
    updateSettings({ usageLimitSources: { [id]: { ...source, accounts } } });
  };

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    const result = await updateCursorSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: enabled } },
    });
    if (result._tag === "Success") {
      await refreshProviders({ environmentId, input: {} });
    }
    setUpdatingCursor(false);
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add hub
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title="Cursor account usage"
            description="Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access."
            control={
              <Switch
                aria-label="Cursor account usage"
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow title="No hubs configured." />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            const accounts =
              serverConfig?.usageLimitSources?.find((snapshot) => snapshot.id === id)?.accounts ??
              [];
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    CLI Proxy{source.enabled ? "" : " · Disabled"}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              >
                {accounts.length > 0 ? (
                  <div className="mt-3 flex flex-col border-t border-border/60 py-1">
                    {accounts.map((account) => {
                      const profile = source.accounts?.[account.id] ?? {};
                      return (
                        <UsageAccountProfileEditor
                          key={`${account.id}:${profile.name ?? ""}`}
                          account={account}
                          profile={profile}
                          readOnly={readOnly}
                          onSave={(next) => saveProfile(id, source, account.id, next)}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The hub's management key is deleted from this server. Its accounts leave the Limits
              view; the hub itself is untouched. Add it again with the URL and key to bring them
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove hub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

const AVATAR_PIXELS = 96;

async function avatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PIXELS;
  canvas.height = AVATAR_PIXELS;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_PIXELS,
    AVATAR_PIXELS,
  );
  bitmap.close();
  // Safari encodes unsupported WebP requests as PNG, which is several times larger.
  const webp = canvas.toDataURL("image/webp", 0.85);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.85);
}

function UsageAccountProfileEditor({
  account,
  profile,
  readOnly,
  onSave,
}: {
  readonly account: UsageLimitSourceAccount;
  readonly profile: UsageLimitSourceAccountProfile;
  readonly readOnly: boolean;
  readonly onSave: (profile: UsageLimitSourceAccountProfile) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(profile.name ?? "");
  const identity = account.email ?? account.id;

  const save = (next: { readonly name?: string; readonly image?: string | undefined }) => {
    const nextName = (next.name ?? name).trim();
    const image = "image" in next ? next.image : profile.image;
    onSave({ ...(nextName ? { name: nextName } : {}), ...(image ? { image } : {}) });
  };

  const chooseImage = async (file: File) => {
    const image = await avatarDataUrl(file).catch(() => null);
    if (!image || image.length > USAGE_ACCOUNT_IMAGE_MAX_LENGTH) {
      toastManager.add({
        type: "error",
        title: "Image not used",
        description: "Choose a PNG, JPEG, or WebP image.",
      });
      return;
    }
    save({ image });
  };

  return (
    <div className="flex items-center gap-3 py-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={readOnly}
              onClick={() => fileInput.current?.click()}
              aria-label={`Choose an image for ${identity}`}
              className="shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            />
          }
        >
          <AccountChip
            email={account.email ?? account.id}
            image={profile.image}
            className="size-8 text-xs"
          />
        </TooltipTrigger>
        <TooltipPopup side="top">Choose image</TooltipPopup>
      </Tooltip>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void chooseImage(file);
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Input
          size="sm"
          value={name}
          placeholder="Name"
          aria-label={`Name for ${identity}`}
          disabled={readOnly}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (name.trim() !== (profile.name ?? "")) save({ name });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span className="truncate text-xs text-muted-foreground">
          {identity}
          {account.plan ? ` · ${account.plan}` : ""}
        </span>
      </div>
      {profile.image && !readOnly ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove the image for ${identity}`}
          onClick={() => save({ image: undefined })}
        >
          <XIcon aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}
