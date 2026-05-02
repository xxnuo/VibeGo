import {
  Check,
  CircleAlert,
  Edit2,
  KeyRound,
  Loader2,
  Plus,
  Power,
  Server,
  ShieldAlert,
  Trash2,
  Unplug,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/api/request";
import {
  type SSHAuthMethod,
  type SSHAuthSecrets,
  type SSHHostKeyChallenge,
  type SSHProfile,
  type SSHProfileInput,
  sshApi,
} from "@/api/ssh";
import { useDialog } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";

export interface SSHConnectionAttempt {
  profile: SSHProfile;
  auth: SSHAuthSecrets;
  cwd: string;
}

interface SSHHostKeyChanged {
  endpoint: string;
  expectedFingerprint: string;
  presentedFingerprint: string;
}

interface SSHProfileForm {
  id?: string;
  name: string;
  host: string;
  port: string;
  user: string;
  authMethod: SSHAuthMethod;
  identityFile: string;
  connectTimeout: string;
}

export interface SSHConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateTerminal?: (attempt: SSHConnectionAttempt) => Promise<void>;
  selectionOnly?: boolean;
  onSelectProfile?: (profile: SSHProfile) => Promise<void> | void;
}

function emptyProfileForm(): SSHProfileForm {
  return {
    name: "",
    host: "",
    port: "22",
    user: "",
    authMethod: "auto",
    identityFile: "",
    connectTimeout: "10",
  };
}

function profileToForm(profile: SSHProfile): SSHProfileForm {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    user: profile.user,
    authMethod: profile.auth_method,
    identityFile: profile.identity_file || "",
    connectTimeout: String(profile.connect_timeout),
  };
}

function formToProfileInput(form: SSHProfileForm): SSHProfileInput {
  return {
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    user: form.user.trim(),
    auth_method: form.authMethod,
    identity_file: form.identityFile.trim(),
    connect_timeout: Number(form.connectTimeout),
  };
}

function apiString(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key] : "";
}

function readHostKeyChallenge(error: unknown): SSHHostKeyChallenge | null {
  if (!(error instanceof ApiError) || error.body.code !== "host_key_confirmation_required") return null;
  const challenge = error.body.challenge;
  if (!challenge || typeof challenge !== "object") return null;
  const value = challenge as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.profile_id !== "string" ||
    typeof value.endpoint !== "string" ||
    typeof value.key_type !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.expires_at !== "number"
  )
    return null;
  return value as unknown as SSHHostKeyChallenge;
}

function readHostKeyChanged(error: unknown): SSHHostKeyChanged | null {
  if (!(error instanceof ApiError) || error.body.code !== "host_key_changed") return null;
  const endpoint = apiString(error.body, "endpoint");
  const expectedFingerprint = apiString(error.body, "expected_fingerprint");
  const presentedFingerprint = apiString(error.body, "presented_fingerprint");
  if (!endpoint || !expectedFingerprint || !presentedFingerprint) return null;
  return { endpoint, expectedFingerprint, presentedFingerprint };
}

function endpointLabel(profile: SSHProfile): string {
  const host = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
  return `${profile.user ? `${profile.user}@` : ""}${host}:${profile.port}`;
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="grid gap-1.5 text-xs text-ide-mute">
    <span>{label}</span>
    {children}
  </label>
);

const SSHConnectionDialog: React.FC<SSHConnectionDialogProps> = ({
  open,
  onOpenChange,
  onCreateTerminal,
  selectionOnly = false,
  onSelectProfile,
}) => {
  const dialog = useDialog();
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const [profiles, setProfiles] = useState<SSHProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [mode, setMode] = useState<"connect" | "edit">("connect");
  const [profileForm, setProfileForm] = useState<SSHProfileForm>(emptyProfileForm);
  const [auth, setAuth] = useState<SSHAuthSecrets>({});
  const [cwd, setCwd] = useState(".");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [challenge, setChallenge] = useState<SSHHostKeyChallenge | null>(null);
  const [changedHostKey, setChangedHostKey] = useState<SSHHostKeyChanged | null>(null);
  const pendingAttemptRef = useRef<SSHConnectionAttempt | null>(null);
  const loadVersionRef = useRef(0);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) || null,
    [profiles, selectedProfileId]
  );

  const clearSecrets = useCallback(() => {
    setAuth({});
    pendingAttemptRef.current = null;
  }, []);

  const loadProfiles = useCallback(
    async (preferredId?: string) => {
      const version = loadVersionRef.current + 1;
      loadVersionRef.current = version;
      setLoading(true);
      setErrorMessage("");
      try {
        const result = await sshApi.listProfiles();
        if (loadVersionRef.current !== version) return;
        setProfiles(result.profiles);
        setSelectedProfileId(
          (currentId) =>
            (preferredId && result.profiles.some((profile) => profile.id === preferredId) && preferredId) ||
            (currentId && result.profiles.some((profile) => profile.id === currentId)
              ? currentId
              : result.profiles[0]?.id || null)
        );
        if (result.profiles.length === 0) {
          setProfileForm(emptyProfileForm());
          setMode("edit");
        }
      } catch (error) {
        if (loadVersionRef.current === version) {
          setErrorMessage(error instanceof Error ? error.message : t("terminal.ssh.loadFailed"));
        }
      } finally {
        if (loadVersionRef.current === version) setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!open) {
      loadVersionRef.current += 1;
      clearSecrets();
      setChallenge(null);
      setChangedHostKey(null);
      setErrorMessage("");
      setSubmitting(false);
      return;
    }
    setCwd(".");
    setMode("connect");
    void loadProfiles();
  }, [clearSecrets, loadProfiles, open]);

  const closeDialog = useCallback(() => {
    clearSecrets();
    onOpenChange(false);
  }, [clearSecrets, onOpenChange]);

  const startNewProfile = useCallback(() => {
    setSelectedProfileId(null);
    setProfileForm(emptyProfileForm());
    setErrorMessage("");
    setMode("edit");
  }, []);

  const startEditProfile = useCallback(() => {
    if (!selectedProfile) return;
    setProfileForm(profileToForm(selectedProfile));
    setErrorMessage("");
    setMode("edit");
  }, [selectedProfile]);

  const saveProfile = useCallback(async () => {
    const input = formToProfileInput(profileForm);
    if (!input.host) {
      setErrorMessage(t("terminal.ssh.hostRequired"));
      return;
    }
    if (profileForm.id && selectedProfile?.connected) {
      const confirmed = await dialog.confirm(
        t("terminal.ssh.updateConnectedTitle"),
        t("terminal.ssh.updateConnectedConfirm"),
        { confirmText: t("common.save") }
      );
      if (!confirmed) return;
    }
    setProfileSaving(true);
    setErrorMessage("");
    try {
      const result = profileForm.id
        ? await sshApi.updateProfile(profileForm.id, input)
        : await sshApi.createProfile(input);
      setMode("connect");
      await loadProfiles(result.profile.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("terminal.ssh.saveFailed"));
    } finally {
      setProfileSaving(false);
    }
  }, [dialog, loadProfiles, profileForm, selectedProfile?.connected, t]);

  const deleteProfile = useCallback(async () => {
    if (!selectedProfile) return;
    const confirmed = await dialog.confirm(
      t("terminal.ssh.deleteProfileTitle"),
      t("terminal.ssh.deleteProfileConfirm").replace("{name}", selectedProfile.name),
      { confirmText: t("common.delete"), confirmVariant: "danger" }
    );
    if (!confirmed) return;
    setProfileSaving(true);
    setErrorMessage("");
    try {
      await sshApi.deleteProfile(selectedProfile.id);
      clearSecrets();
      await loadProfiles();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("terminal.ssh.deleteFailed"));
    } finally {
      setProfileSaving(false);
    }
  }, [clearSecrets, dialog, loadProfiles, selectedProfile, t]);

  const disconnectProfile = useCallback(async () => {
    if (!selectedProfile) return;
    const confirmed = await dialog.confirm(
      t("terminal.ssh.disconnectTitle"),
      t("terminal.ssh.disconnectConfirm").replace("{name}", selectedProfile.name),
      { confirmText: t("terminal.ssh.disconnect"), confirmVariant: "danger" }
    );
    if (!confirmed) return;
    setProfileSaving(true);
    setErrorMessage("");
    try {
      await sshApi.disconnect(selectedProfile.id);
      await loadProfiles(selectedProfile.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("terminal.ssh.disconnectFailed"));
    } finally {
      setProfileSaving(false);
    }
  }, [dialog, loadProfiles, selectedProfile, t]);

  const attemptConnection = useCallback(
    async (attempt: SSHConnectionAttempt) => {
      pendingAttemptRef.current = attempt;
      setSubmitting(true);
      setErrorMessage("");
      try {
        if (selectionOnly) {
          await sshApi.connect(attempt.profile.id, attempt.auth);
          await onSelectProfile?.(attempt.profile);
        } else {
          if (!onCreateTerminal) throw new Error("SSH terminal callback is unavailable");
          await onCreateTerminal(attempt);
        }
        closeDialog();
      } catch (error) {
        const nextChallenge = readHostKeyChallenge(error);
        if (nextChallenge) {
          setChallenge(nextChallenge);
          return;
        }
        const changed = readHostKeyChanged(error);
        if (changed) {
          setChangedHostKey(changed);
          return;
        }
        const code = error instanceof ApiError ? error.body.code : "";
        if (code === "ssh_authentication_required") {
          setErrorMessage(t("terminal.ssh.authenticationRequired"));
        } else if (code === "ssh_authentication_failed") {
          setErrorMessage(t("terminal.ssh.authenticationFailed"));
        } else if (code === "ssh_connect_timeout") {
          setErrorMessage(t("terminal.ssh.connectTimedOut"));
        } else {
          setErrorMessage(error instanceof Error ? error.message : t("terminal.ssh.connectFailed"));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [closeDialog, onCreateTerminal, onSelectProfile, selectionOnly, t]
  );

  const connectProfile = useCallback(() => {
    if (!selectedProfile) return;
    void attemptConnection({
      profile: selectedProfile,
      auth: {
        password: auth.password || undefined,
        private_key: auth.private_key || undefined,
        passphrase: auth.passphrase || undefined,
      },
      cwd: cwd.trim() || ".",
    });
  }, [attemptConnection, auth, cwd, selectedProfile]);

  const confirmHostKey = useCallback(async () => {
    const attempt = pendingAttemptRef.current;
    if (!challenge || !attempt) return;
    setSubmitting(true);
    setErrorMessage("");
    try {
      await sshApi.confirmHostKey(challenge.id);
      setChallenge(null);
      await attemptConnection(attempt);
    } catch (error) {
      setChallenge(null);
      setErrorMessage(error instanceof Error ? error.message : t("terminal.ssh.confirmHostKeyFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [attemptConnection, challenge, t]);

  const resetChangedHostKey = useCallback(async () => {
    const attempt = pendingAttemptRef.current;
    if (!changedHostKey || !attempt) return;
    setSubmitting(true);
    setErrorMessage("");
    try {
      await sshApi.resetKnownHost(attempt.profile.id, changedHostKey.expectedFingerprint);
      setChangedHostKey(null);
      await attemptConnection(attempt);
    } catch (error) {
      setChangedHostKey(null);
      setErrorMessage(error instanceof Error ? error.message : t("terminal.ssh.resetHostKeyFailed"));
    } finally {
      setSubmitting(false);
    }
  }, [attemptConnection, changedHostKey, t]);

  const showPassword = selectedProfile?.auth_method === "auto" || selectedProfile?.auth_method === "password";
  const showPrivateKey = selectedProfile?.auth_method === "auto" || selectedProfile?.auth_method === "private_key";

  return (
    <>
      <Dialog open={open} onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : closeDialog())}>
        <DialogContent className="border-ide-border bg-ide-panel p-0 text-ide-text md:max-w-4xl md:overflow-hidden">
          <DialogHeader className="border-b border-ide-border px-5 py-4 text-left">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Server size={17} className="text-ide-accent" />
              {t("terminal.ssh.title")}
            </DialogTitle>
            <DialogDescription className="text-xs text-ide-mute">
              {t("terminal.ssh.requestOnlySecrets")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid min-h-[430px] md:grid-cols-[220px_minmax(0,1fr)]">
            <aside className="border-b border-ide-border bg-ide-bg md:border-r md:border-b-0">
              <div className="flex items-center justify-between border-b border-ide-border px-3 py-2">
                <span className="text-xs font-medium text-ide-mute">{t("terminal.ssh.profiles")}</span>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-ide-text"
                  title={t("terminal.ssh.newProfile")}
                  aria-label={t("terminal.ssh.newProfile")}
                  onClick={startNewProfile}
                >
                  <Plus size={14} />
                </button>
              </div>
              <div className="max-h-40 overflow-auto p-1.5 md:max-h-[376px]">
                {loading ? (
                  <div className="flex h-24 items-center justify-center text-ide-mute">
                    <Loader2 size={16} className="animate-spin" />
                  </div>
                ) : profiles.length === 0 ? (
                  <div className="px-3 py-8 text-center text-xs text-ide-mute">{t("terminal.ssh.noProfiles")}</div>
                ) : (
                  profiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className={`flex w-full items-center gap-2 border-l-2 px-2 py-2 text-left ${
                        profile.id === selectedProfileId && mode === "connect"
                          ? "border-ide-accent bg-ide-panel text-ide-text"
                          : "border-transparent text-ide-mute hover:bg-ide-panel hover:text-ide-text"
                      }`}
                      onClick={() => {
                        setSelectedProfileId(profile.id);
                        setMode("connect");
                        setErrorMessage("");
                        clearSecrets();
                      }}
                    >
                      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center border border-ide-border">
                        <Server size={14} />
                        <span
                          className={`absolute right-[-3px] bottom-[-3px] h-2 w-2 border border-ide-bg ${
                            profile.connected ? "bg-green-500" : "bg-ide-mute"
                          }`}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{profile.name}</span>
                        <span className="block truncate text-[11px] text-ide-mute">{endpointLabel(profile)}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <main className="min-w-0 overflow-auto px-5 py-4">
              {mode === "edit" ? (
                <div className="grid gap-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium">
                      {profileForm.id ? t("terminal.ssh.editProfile") : t("terminal.ssh.newProfile")}
                    </h3>
                    {profileForm.id && (
                      <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-red-500"
                        title={t("terminal.ssh.deleteProfile")}
                        aria-label={t("terminal.ssh.deleteProfile")}
                        onClick={() => void deleteProfile()}
                        disabled={profileSaving}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("terminal.ssh.name")}>
                      <Input
                        value={profileForm.name}
                        onChange={(event) => setProfileForm((value) => ({ ...value, name: event.target.value }))}
                        className="border-ide-border bg-ide-bg"
                      />
                    </Field>
                    <Field label={t("terminal.ssh.user")}>
                      <Input
                        value={profileForm.user}
                        onChange={(event) => setProfileForm((value) => ({ ...value, user: event.target.value }))}
                        className="border-ide-border bg-ide-bg"
                      />
                    </Field>
                    <Field label={t("terminal.ssh.host")}>
                      <Input
                        value={profileForm.host}
                        onChange={(event) => setProfileForm((value) => ({ ...value, host: event.target.value }))}
                        className="border-ide-border bg-ide-bg font-mono"
                        autoFocus
                      />
                    </Field>
                    <Field label={t("terminal.ssh.port")}>
                      <Input
                        type="number"
                        min={1}
                        max={65535}
                        value={profileForm.port}
                        onChange={(event) => setProfileForm((value) => ({ ...value, port: event.target.value }))}
                        className="border-ide-border bg-ide-bg font-mono"
                      />
                    </Field>
                    <Field label={t("terminal.ssh.authMethod")}>
                      <NativeSelect
                        value={profileForm.authMethod}
                        onChange={(event) =>
                          setProfileForm((value) => ({ ...value, authMethod: event.target.value as SSHAuthMethod }))
                        }
                        className="w-full border-ide-border bg-ide-bg"
                      >
                        <NativeSelectOption value="auto">{t("terminal.ssh.authAuto")}</NativeSelectOption>
                        <NativeSelectOption value="agent">{t("terminal.ssh.authAgent")}</NativeSelectOption>
                        <NativeSelectOption value="private_key">{t("terminal.ssh.authPrivateKey")}</NativeSelectOption>
                        <NativeSelectOption value="password">{t("terminal.ssh.authPassword")}</NativeSelectOption>
                      </NativeSelect>
                    </Field>
                    <Field label={t("terminal.ssh.connectTimeoutLabel")}>
                      <Input
                        type="number"
                        min={1}
                        max={60}
                        value={profileForm.connectTimeout}
                        onChange={(event) =>
                          setProfileForm((value) => ({ ...value, connectTimeout: event.target.value }))
                        }
                        className="border-ide-border bg-ide-bg font-mono"
                      />
                    </Field>
                  </div>
                  {(profileForm.authMethod === "auto" || profileForm.authMethod === "private_key") && (
                    <Field label={t("terminal.ssh.identityFile")}>
                      <Input
                        value={profileForm.identityFile}
                        onChange={(event) =>
                          setProfileForm((value) => ({ ...value, identityFile: event.target.value }))
                        }
                        className="border-ide-border bg-ide-bg font-mono"
                        placeholder="~/.ssh/id_ed25519"
                      />
                    </Field>
                  )}
                  <div className="flex justify-end gap-2 border-t border-ide-border pt-4">
                    {(selectedProfile || profiles.length > 0) && (
                      <Button variant="outline" onClick={() => setMode("connect")} disabled={profileSaving}>
                        {t("common.cancel")}
                      </Button>
                    )}
                    <Button onClick={() => void saveProfile()} disabled={profileSaving}>
                      {profileSaving ? <Loader2 className="animate-spin" /> : <Check />}
                      {t("common.save")}
                    </Button>
                  </div>
                </div>
              ) : selectedProfile ? (
                <div className="grid gap-4">
                  <div className="flex items-start justify-between gap-3 border-b border-ide-border pb-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-medium">{selectedProfile.name}</h3>
                        <span
                          className={`text-[11px] ${selectedProfile.connected ? "text-green-500" : "text-ide-mute"}`}
                        >
                          {selectedProfile.connected ? t("common.connected") : t("terminal.ssh.disconnected")}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-ide-mute">{endpointLabel(selectedProfile)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {selectedProfile.connected && (
                        <button
                          type="button"
                          className="flex h-8 w-8 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-red-500"
                          title={t("terminal.ssh.disconnect")}
                          aria-label={t("terminal.ssh.disconnect")}
                          onClick={() => void disconnectProfile()}
                          disabled={profileSaving}
                        >
                          <Unplug size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="flex h-8 w-8 items-center justify-center text-ide-mute hover:bg-ide-bg hover:text-ide-text"
                        title={t("terminal.ssh.editProfile")}
                        aria-label={t("terminal.ssh.editProfile")}
                        onClick={startEditProfile}
                      >
                        <Edit2 size={14} />
                      </button>
                    </div>
                  </div>

                  {!selectionOnly && (
                    <Field label={t("terminal.ssh.remoteCwd")}>
                      <Input
                        value={cwd}
                        onChange={(event) => setCwd(event.target.value)}
                        className="border-ide-border bg-ide-bg font-mono"
                        placeholder="."
                      />
                    </Field>
                  )}

                  {showPassword && (
                    <Field label={t("terminal.ssh.password")}>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={auth.password || ""}
                        onChange={(event) => setAuth((value) => ({ ...value, password: event.target.value }))}
                        className="border-ide-border bg-ide-bg"
                      />
                    </Field>
                  )}

                  {showPrivateKey && (
                    <Field label={t("terminal.ssh.privateKey")}>
                      <Textarea
                        value={auth.private_key || ""}
                        onChange={(event) => setAuth((value) => ({ ...value, private_key: event.target.value }))}
                        className="max-h-32 min-h-20 resize-y border-ide-border bg-ide-bg font-mono text-xs"
                      />
                    </Field>
                  )}

                  {showPrivateKey && (
                    <Field label={t("terminal.ssh.passphrase")}>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={auth.passphrase || ""}
                        onChange={(event) => setAuth((value) => ({ ...value, passphrase: event.target.value }))}
                        className="border-ide-border bg-ide-bg"
                      />
                    </Field>
                  )}

                  {selectedProfile.auth_method === "agent" && (
                    <div className="flex items-center gap-2 border-y border-ide-border py-3 text-xs text-ide-mute">
                      <KeyRound size={14} />
                      {t("terminal.ssh.agentSelected")}
                    </div>
                  )}

                  {errorMessage && (
                    <div className="flex items-start gap-2 border-l-2 border-red-500 bg-red-500/5 px-3 py-2 text-xs text-red-500">
                      <CircleAlert size={14} className="mt-0.5 shrink-0" />
                      <span className="break-words">{errorMessage}</span>
                    </div>
                  )}

                  <div className="flex justify-end border-t border-ide-border pt-4">
                    <Button onClick={connectProfile} disabled={submitting || loading}>
                      {submitting ? <Loader2 className="animate-spin" /> : selectionOnly ? <Check /> : <Power />}
                      {selectionOnly ? t("common.select") : t("terminal.ssh.openTerminal")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </main>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!challenge} onOpenChange={(nextOpen) => !nextOpen && setChallenge(null)}>
        <DialogContent className="border-ide-border bg-ide-panel text-ide-text md:max-w-lg">
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldAlert size={17} className="text-yellow-500" />
              {t("terminal.ssh.hostKeyTitle")}
            </DialogTitle>
            <DialogDescription className="text-sm text-ide-mute">{t("terminal.ssh.hostKeyConfirm")}</DialogDescription>
          </DialogHeader>
          {challenge && (
            <dl className="grid gap-2 border-y border-ide-border py-3 text-xs">
              <div className="grid grid-cols-[90px_1fr] gap-3">
                <dt className="text-ide-mute">{t("terminal.ssh.endpoint")}</dt>
                <dd className="break-all font-mono">{challenge.endpoint}</dd>
              </div>
              <div className="grid grid-cols-[90px_1fr] gap-3">
                <dt className="text-ide-mute">{t("terminal.ssh.keyType")}</dt>
                <dd className="break-all font-mono">{challenge.key_type}</dd>
              </div>
              <div className="grid grid-cols-[90px_1fr] gap-3">
                <dt className="text-ide-mute">{t("terminal.ssh.fingerprint")}</dt>
                <dd className="break-all font-mono">{challenge.fingerprint}</dd>
              </div>
            </dl>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setChallenge(null)} disabled={submitting}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void confirmHostKey()} disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : <Check />}
              {t("terminal.ssh.trustAndConnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!changedHostKey} onOpenChange={(nextOpen) => !nextOpen && setChangedHostKey(null)}>
        <DialogContent className="border-red-500/40 bg-ide-panel text-ide-text md:max-w-lg">
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-center gap-2 text-base text-red-500">
              <ShieldAlert size={17} />
              {t("terminal.ssh.hostKeyChangedTitle")}
            </DialogTitle>
            <DialogDescription className="text-sm text-ide-mute">
              {t("terminal.ssh.hostKeyChangedConfirm")}
            </DialogDescription>
          </DialogHeader>
          {changedHostKey && (
            <dl className="grid gap-2 border-y border-ide-border py-3 text-xs">
              <div className="grid grid-cols-[110px_1fr] gap-3">
                <dt className="text-ide-mute">{t("terminal.ssh.endpoint")}</dt>
                <dd className="break-all font-mono">{changedHostKey.endpoint}</dd>
              </div>
              <div className="grid grid-cols-[110px_1fr] gap-3">
                <dt className="text-ide-mute">{t("terminal.ssh.previousFingerprint")}</dt>
                <dd className="break-all font-mono">{changedHostKey.expectedFingerprint}</dd>
              </div>
              <div className="grid grid-cols-[110px_1fr] gap-3">
                <dt className="text-ide-mute">{t("terminal.ssh.presentedFingerprint")}</dt>
                <dd className="break-all font-mono text-red-500">{changedHostKey.presentedFingerprint}</dd>
              </div>
            </dl>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setChangedHostKey(null)} disabled={submitting}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void resetChangedHostKey()} disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t("terminal.ssh.resetHostKey")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default SSHConnectionDialog;
