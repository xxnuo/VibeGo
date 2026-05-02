import { Layers, Loader2, Save } from "lucide-react";
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createBlockTermSettingsDialogSubmissionGuard } from "@/components/terminal/blockterm-session-settings";
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
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores";

const BLOCKTERM_WORKSPACE_NAME_MAX_LENGTH = 50;

type NameValidationError = "required" | "tooLong";

export interface BlockTermWorkspaceSettingsValues {
  name: string;
}

export interface BlockTermWorkspaceSettingsDialogProps {
  open: boolean;
  initialValues?: Partial<BlockTermWorkspaceSettingsValues> | null;
  initialName?: string;
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (values: BlockTermWorkspaceSettingsValues) => void | Promise<void>;
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

const BlockTermWorkspaceSettingsDialog: React.FC<BlockTermWorkspaceSettingsDialogProps> = ({
  open,
  initialValues,
  initialName = "",
  loading = false,
  saving = false,
  error,
  onOpenChange,
  onSave,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const fieldId = useId();
  const nameInputId = `${fieldId}-name`;
  const nameErrorId = `${fieldId}-name-error`;
  const saveErrorId = `${fieldId}-save-error`;
  const sourceName = initialValues?.name ?? initialName;
  const [name, setName] = useState(sourceName);
  const [internalSaving, setInternalSaving] = useState(false);
  const [internalError, setInternalError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<NameValidationError | null>(null);
  const wasOpenRef = useRef(false);
  const wasLoadingRef = useRef(loading);
  const submissionGuardRef = useRef<ReturnType<typeof createBlockTermSettingsDialogSubmissionGuard> | null>(null);
  if (!submissionGuardRef.current) {
    submissionGuardRef.current = createBlockTermSettingsDialogSubmissionGuard(open);
  }
  const submissionGuard = submissionGuardRef.current;

  useLayoutEffect(() => {
    submissionGuard.syncOpen(open);
  }, [open, submissionGuard]);

  const initializeDraft = useCallback(() => {
    setName(sourceName);
    setInternalError(null);
    setValidationError(null);
  }, [sourceName]);

  useEffect(() => {
    if (open && (!wasOpenRef.current || (wasLoadingRef.current && !loading))) initializeDraft();
    if (!open) {
      setInternalSaving(false);
      setInternalError(null);
      setValidationError(null);
    }
    wasOpenRef.current = open;
    wasLoadingRef.current = loading;
  }, [initializeDraft, loading, open]);

  const effectiveSaving = internalSaving || saving;
  const effectiveError = error || internalError;
  const normalizedName = name.trim();
  const nameLength = countCharacters(normalizedName);
  const dirty = normalizedName !== sourceName.trim();

  const validationMessage = useMemo(() => {
    if (validationError === "required") return t("plugin.blockTerm.workspaceSettings.nameRequired");
    if (validationError === "tooLong") return t("plugin.blockTerm.workspaceSettings.nameTooLong");
    return null;
  }, [t, validationError]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (loading || effectiveSaving) return;
      if (!normalizedName) {
        setValidationError("required");
        return;
      }
      if (countCharacters(normalizedName) > BLOCKTERM_WORKSPACE_NAME_MAX_LENGTH) {
        setValidationError("tooLong");
        return;
      }

      setInternalSaving(true);
      setInternalError(null);
      setValidationError(null);
      const submission = submissionGuard.begin();
      try {
        await onSave({ name: normalizedName });
        if (submissionGuard.isCurrent(submission)) onOpenChange(false);
      } catch (cause) {
        if (submissionGuard.isCurrent(submission)) {
          setInternalError(cause instanceof Error ? cause.message : t("plugin.blockTerm.workspaceSettings.saveFailed"));
        }
      } finally {
        if (submissionGuard.isCurrent(submission)) setInternalSaving(false);
      }
    },
    [effectiveSaving, loading, normalizedName, onOpenChange, onSave, submissionGuard, t]
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && effectiveSaving) return;
      onOpenChange(nextOpen);
    },
    [effectiveSaving, onOpenChange]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-blockterm-workspace-settings-dialog
        showCloseButton={!effectiveSaving}
        className="grid max-h-[min(88dvh,30rem)] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-t-md border-ide-border bg-ide-panel p-0 text-ide-text md:max-w-lg md:grid-rows-[auto_minmax(0,1fr)] md:rounded-md"
      >
        <DialogHeader className="border-b border-ide-border px-4 py-3 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base text-ide-text">
            <Layers size={16} className="text-ide-accent" />
            {t("plugin.blockTerm.workspaceSettings.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("plugin.blockTerm.workspaceSettings.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]" onSubmit={handleSubmit}>
          <div className="min-h-0 space-y-4 overflow-y-auto p-4 custom-scrollbar">
            {loading ? (
              <div className="flex min-h-32 items-center justify-center text-ide-mute">
                <Loader2 size={18} className="animate-spin" aria-label={t("common.loading")} />
              </div>
            ) : (
              <label htmlFor={nameInputId} className="block space-y-1.5">
                <span className="text-xs font-medium text-ide-text">
                  {t("plugin.blockTerm.workspaceSettings.name")}
                </span>
                <Input
                  id={nameInputId}
                  name="blockterm-workspace-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setInternalError(null);
                    setValidationError(null);
                  }}
                  autoFocus
                  autoComplete="off"
                  disabled={effectiveSaving}
                  aria-invalid={validationError !== null}
                  aria-describedby={validationMessage ? nameErrorId : undefined}
                  className="h-11 border-ide-border bg-ide-bg text-base text-ide-text placeholder:text-ide-mute focus-visible:border-ide-accent focus-visible:ring-ide-accent/20 md:h-9 md:text-sm"
                  placeholder={t("plugin.blockTerm.workspaceSettings.namePlaceholder")}
                />
                <span className="flex min-h-4 items-start justify-between gap-3 text-[11px]">
                  <span id={nameErrorId} className={validationMessage ? "text-red-500" : "text-transparent"}>
                    {validationMessage || "-"}
                  </span>
                  <span className={nameLength > BLOCKTERM_WORKSPACE_NAME_MAX_LENGTH ? "text-red-500" : "text-ide-mute"}>
                    {nameLength}/{BLOCKTERM_WORKSPACE_NAME_MAX_LENGTH}
                  </span>
                </span>
              </label>
            )}

            {effectiveError && (
              <div
                id={saveErrorId}
                role="alert"
                className="border border-red-500/40 bg-red-500/8 px-3 py-2 text-xs leading-5 text-red-500"
              >
                {effectiveError}
              </div>
            )}
          </div>

          <DialogFooter className="border-t border-ide-border bg-ide-panel px-4 py-3 md:pt-3">
            <Button
              type="button"
              variant="outline"
              disabled={effectiveSaving}
              onClick={() => handleOpenChange(false)}
              className="h-11 w-full border-ide-border bg-ide-panel text-ide-text hover:bg-ide-bg md:h-9 md:w-auto"
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              data-blockterm-workspace-settings-save
              disabled={loading || effectiveSaving || !dirty}
              aria-describedby={effectiveError ? saveErrorId : undefined}
              className="h-11 w-full bg-ide-accent text-ide-on-accent hover:bg-ide-accent/90 md:h-9 md:w-auto"
            >
              {effectiveSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export { BlockTermWorkspaceSettingsDialog };
export default BlockTermWorkspaceSettingsDialog;
