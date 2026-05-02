import { Loader2, Save, Settings2 } from "lucide-react";
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import BlockTermSessionIcon from "@/components/terminal/blockterm-session-icon";
import {
  BLOCKTERM_TAB_COLORS,
  BLOCKTERM_TAB_ICONS,
  type BlockTermTabColor,
  type BlockTermTabIcon,
  createBlockTermSettingsDialogSubmissionGuard,
  normalizeBlockTermTabColor,
  normalizeBlockTermTabIcon,
} from "@/components/terminal/blockterm-session-settings";
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

const BLOCKTERM_NAME_MAX_LENGTH = 50;

type NameValidationError = "required" | "tooLong";

export interface BlockTermSessionSettingsValues {
  name: string;
  tabColor: BlockTermTabColor;
  tabIcon: BlockTermTabIcon;
}

export interface BlockTermSessionSettingsDialogProps {
  open: boolean;
  initialValues?: Partial<BlockTermSessionSettingsValues> | null;
  initialName?: string;
  initialColor?: BlockTermTabColor | string | null;
  initialIcon?: BlockTermTabIcon | string | null;
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (values: BlockTermSessionSettingsValues) => void | Promise<void>;
}

function countCharacters(value: string): number {
  return Array.from(value).length;
}

const BlockTermSessionSettingsDialog: React.FC<BlockTermSessionSettingsDialogProps> = ({
  open,
  initialValues,
  initialName = "",
  initialColor,
  initialIcon,
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
  const sourceColor = normalizeBlockTermTabColor(initialValues?.tabColor ?? initialColor);
  const sourceIcon = normalizeBlockTermTabIcon(initialValues?.tabIcon ?? initialIcon);
  const [name, setName] = useState(sourceName);
  const [tabColor, setTabColor] = useState<BlockTermTabColor>(sourceColor);
  const [tabIcon, setTabIcon] = useState<BlockTermTabIcon>(sourceIcon);
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
    setTabColor(sourceColor);
    setTabIcon(sourceIcon);
    setInternalError(null);
    setValidationError(null);
  }, [sourceColor, sourceIcon, sourceName]);

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
  const dirty = normalizedName !== sourceName.trim() || tabColor !== sourceColor || tabIcon !== sourceIcon;
  const selectedLabel = normalizedName || t("plugin.blockTerm.sessionSettings.namePlaceholder");

  const validationMessage = useMemo(() => {
    if (validationError === "required") return t("plugin.blockTerm.sessionSettings.nameRequired");
    if (validationError === "tooLong") return t("plugin.blockTerm.sessionSettings.nameTooLong");
    return null;
  }, [t, validationError]);

  const clearErrors = useCallback(() => {
    setInternalError(null);
    setValidationError(null);
  }, []);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (loading || effectiveSaving) return;
      if (!normalizedName) {
        setValidationError("required");
        return;
      }
      if (countCharacters(normalizedName) > BLOCKTERM_NAME_MAX_LENGTH) {
        setValidationError("tooLong");
        return;
      }

      setInternalSaving(true);
      setInternalError(null);
      setValidationError(null);
      const submission = submissionGuard.begin();
      try {
        await onSave({ name: normalizedName, tabColor, tabIcon });
        if (submissionGuard.isCurrent(submission)) onOpenChange(false);
      } catch (cause) {
        if (submissionGuard.isCurrent(submission)) {
          setInternalError(cause instanceof Error ? cause.message : t("plugin.blockTerm.sessionSettings.saveFailed"));
        }
      } finally {
        if (submissionGuard.isCurrent(submission)) setInternalSaving(false);
      }
    },
    [effectiveSaving, loading, normalizedName, onOpenChange, onSave, submissionGuard, t, tabColor, tabIcon]
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
        data-blockterm-session-settings-dialog
        showCloseButton={!effectiveSaving}
        className="grid max-h-[min(88dvh,42rem)] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-t-md border-ide-border bg-ide-panel p-0 text-ide-text md:max-w-xl md:grid-rows-[auto_minmax(0,1fr)] md:rounded-md"
      >
        <DialogHeader className="border-b border-ide-border px-4 py-3 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base text-ide-text">
            <Settings2 size={16} className="text-ide-accent" />
            {t("plugin.blockTerm.sessionSettings.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("plugin.blockTerm.sessionSettings.description")}</DialogDescription>
        </DialogHeader>

        <form className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]" onSubmit={handleSubmit}>
          <div className="min-h-0 space-y-5 overflow-y-auto p-4 custom-scrollbar">
            {loading ? (
              <div className="flex min-h-48 items-center justify-center text-ide-mute">
                <Loader2 size={18} className="animate-spin" aria-label={t("common.loading")} />
              </div>
            ) : (
              <fieldset className="space-y-5" disabled={effectiveSaving}>
                <label htmlFor={nameInputId} className="block space-y-1.5">
                  <span className="text-xs font-medium text-ide-text">
                    {t("plugin.blockTerm.sessionSettings.name")}
                  </span>
                  <Input
                    id={nameInputId}
                    name="blockterm-session-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      clearErrors();
                    }}
                    autoFocus
                    autoComplete="off"
                    aria-invalid={validationError !== null}
                    aria-describedby={validationMessage ? nameErrorId : undefined}
                    className="h-11 border-ide-border bg-ide-bg text-base text-ide-text placeholder:text-ide-mute focus-visible:border-ide-accent focus-visible:ring-ide-accent/20 md:h-9 md:text-sm"
                    placeholder={t("plugin.blockTerm.sessionSettings.namePlaceholder")}
                  />
                  <span className="flex min-h-4 items-start justify-between gap-3 text-[11px]">
                    <span id={nameErrorId} className={validationMessage ? "text-red-500" : "text-transparent"}>
                      {validationMessage || "-"}
                    </span>
                    <span className={nameLength > BLOCKTERM_NAME_MAX_LENGTH ? "text-red-500" : "text-ide-mute"}>
                      {nameLength}/{BLOCKTERM_NAME_MAX_LENGTH}
                    </span>
                  </span>
                </label>

                <div className="flex h-11 min-w-0 items-center gap-2 border-y border-ide-border px-1">
                  <BlockTermSessionIcon icon={tabIcon} color={tabColor} size={17} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ide-text">{selectedLabel}</span>
                </div>

                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-ide-text">
                    {t("plugin.blockTerm.sessionSettings.color")}
                  </legend>
                  <div className="grid grid-cols-6 border-l border-t border-ide-border sm:grid-cols-11">
                    {BLOCKTERM_TAB_COLORS.map((color) => {
                      const selected = tabColor === color;
                      const label = t(`plugin.blockTerm.sessionSettings.colors.${color}`);
                      return (
                        <button
                          key={color}
                          type="button"
                          data-blockterm-tab-color-option={color}
                          aria-label={label}
                          aria-pressed={selected}
                          title={label}
                          className={`flex h-11 items-center justify-center border-r border-b border-ide-border transition-colors md:h-9 ${
                            selected
                              ? "bg-ide-accent/10 ring-1 ring-inset ring-ide-accent"
                              : "bg-ide-bg hover:bg-ide-panel"
                          }`}
                          onClick={() => {
                            setTabColor(color);
                            clearErrors();
                          }}
                        >
                          {color === "default" ? (
                            <span className="flex size-4 items-center justify-center rounded-full border border-ide-border bg-ide-panel">
                              <span className="size-1.5 rounded-full bg-ide-accent" />
                            </span>
                          ) : (
                            <BlockTermSessionIcon icon="square" color={color} size={15} />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <fieldset className="space-y-2">
                  <legend className="text-xs font-medium text-ide-text">
                    {t("plugin.blockTerm.sessionSettings.icon")}
                  </legend>
                  <div className="grid grid-cols-6 border-l border-t border-ide-border sm:grid-cols-12">
                    {BLOCKTERM_TAB_ICONS.map((icon) => {
                      const selected = tabIcon === icon;
                      const label = t(`plugin.blockTerm.sessionSettings.icons.${icon}`);
                      return (
                        <button
                          key={icon}
                          type="button"
                          data-blockterm-tab-icon-option={icon}
                          aria-label={label}
                          aria-pressed={selected}
                          title={label}
                          className={`flex h-11 items-center justify-center border-r border-b border-ide-border transition-colors md:h-9 ${
                            selected
                              ? "bg-ide-accent/10 ring-1 ring-inset ring-ide-accent"
                              : "bg-ide-bg hover:bg-ide-panel"
                          }`}
                          onClick={() => {
                            setTabIcon(icon);
                            clearErrors();
                          }}
                        >
                          <BlockTermSessionIcon icon={icon} color={tabColor} size={16} />
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              </fieldset>
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
              data-blockterm-session-settings-save
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

export { BlockTermSessionSettingsDialog };
export default BlockTermSessionSettingsDialog;
