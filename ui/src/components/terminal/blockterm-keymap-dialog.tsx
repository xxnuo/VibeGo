import { CircleAlert, Keyboard, LoaderCircle, RotateCcw, Save, X } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { settingsApi } from "@/api/settings";
import {
  BLOCKTERM_KEYMAP_COMMAND_DEFINITIONS,
  BLOCKTERM_KEYMAP_MAX_KEYS_PER_BINDING,
  BLOCKTERM_KEYMAP_SETTING_KEY,
  type BlockTermKeybinding,
  type BlockTermKeymap,
  type BlockTermKeymapCommandDefinition,
  type BlockTermKeymapScope,
  createBlockTermKeymapOverrides,
  getBlockTermKeyDescriptorFromEvent,
  getBlockTermKeymapDefaults,
  getBlockTermKeymapDisplayBindings,
  parseBlockTermKeymapConfig,
  serializeBlockTermKeymapBindings,
} from "@/components/terminal/blockterm-keymap";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/settings";
import { useAppStore } from "@/stores";

export interface BlockTermKeymapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value?: string | null;
  effectiveBindings?: readonly BlockTermKeybinding[];
  settingKey?: string;
  onSaved?: (value: string, keymap: BlockTermKeymap) => void;
}

type Translate = (key: string) => string;

const KEYMAP_SCOPES: readonly BlockTermKeymapScope[] = ["app", "desktop", "input"];

function copyBindings(bindings: readonly BlockTermKeybinding[]): BlockTermKeybinding[] {
  return bindings.map((binding) => ({ ...binding, keys: [...binding.keys] }));
}

function interpolate(value: string, replacements: Record<string, string | number>): string {
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.replaceAll(`{${key}}`, String(replacement)),
    value
  );
}

function getDefinitionLabel(definition: BlockTermKeymapCommandDefinition, t: Translate): string {
  const tabMatch = /^app:selectTab-([1-9])$/u.exec(definition.command);
  if (tabMatch) return interpolate(t(definition.labelKey), { index: tabMatch[1] });
  const workspaceMatch = /^app:selectWorkspace-([1-9])$/u.exec(definition.command);
  if (workspaceMatch) return interpolate(t(definition.labelKey), { index: workspaceMatch[1] });
  return t(definition.labelKey);
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/iu.test(navigator.platform || navigator.userAgent || "");
}

const BlockTermKeymapDialog: React.FC<BlockTermKeymapDialogProps> = ({
  open,
  onOpenChange,
  value,
  effectiveBindings,
  settingKey = BLOCKTERM_KEYMAP_SETTING_KEY,
  onSaved,
}) => {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  const storedValue = useSettingsStore((state) => state.settings[settingKey]);
  const sourceValue = value === undefined ? storedValue : value;
  const [scope, setScope] = useState<BlockTermKeymapScope>("app");
  const [bindings, setBindings] = useState<BlockTermKeybinding[]>(() => getBlockTermKeymapDefaults());
  const [recordingCommand, setRecordingCommand] = useState<string | null>(null);
  const [initialSerialized, setInitialSerialized] = useState("[]");
  const [sourceInvalid, setSourceInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const wasOpenRef = useRef(false);

  const initializeDraft = useCallback(() => {
    const parsed = parseBlockTermKeymapConfig(sourceValue);
    const keymap = effectiveBindings
      ? parseBlockTermKeymapConfig(serializeBlockTermKeymapBindings(createBlockTermKeymapOverrides(effectiveBindings)))
          .keymap
      : parsed.keymap;
    const nextBindings = getBlockTermKeymapDisplayBindings(keymap);
    const serialized = serializeBlockTermKeymapBindings(createBlockTermKeymapOverrides(nextBindings));
    setBindings(nextBindings);
    setInitialSerialized(serialized);
    setSourceInvalid(!parsed.valid);
    setRecordingCommand(null);
    setScope("app");
  }, [effectiveBindings, sourceValue]);

  useEffect(() => {
    if (open && !wasOpenRef.current) initializeDraft();
    if (!open) {
      setRecordingCommand(null);
      setSaving(false);
    }
    wasOpenRef.current = open;
  }, [initializeDraft, open]);

  const draftSerialized = useMemo(
    () => serializeBlockTermKeymapBindings(createBlockTermKeymapOverrides(bindings)),
    [bindings]
  );
  const preview = useMemo(() => parseBlockTermKeymapConfig(draftSerialized), [draftSerialized]);
  const conflictDiagnostics = useMemo(
    () => preview.diagnostics.filter((diagnostic) => diagnostic.kind === "conflict"),
    [preview.diagnostics]
  );
  const conflictKeys = useMemo(
    () =>
      new Set(
        conflictDiagnostics.flatMap((diagnostic) =>
          diagnostic.command && diagnostic.key ? [`${diagnostic.command}\u0000${diagnostic.key}`] : []
        )
      ),
    [conflictDiagnostics]
  );
  const conflictCount = conflictDiagnostics.length;
  const dirty = sourceInvalid || draftSerialized !== initialSerialized;

  const definitions = useMemo(
    () => BLOCKTERM_KEYMAP_COMMAND_DEFINITIONS.filter((definition) => definition.scope === scope),
    [scope]
  );
  const bindingsByCommand = useMemo(() => new Map(bindings.map((binding) => [binding.command, binding])), [bindings]);

  const updateCommandKeys = useCallback((command: string, updater: (keys: string[]) => string[]) => {
    setBindings((current) =>
      current.map((binding) =>
        binding.command === command ? { ...binding, keys: updater([...binding.keys]) } : binding
      )
    );
  }, []);

  useEffect(() => {
    if (!open || !recordingCommand) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setRecordingCommand(null);
        return;
      }
      const descriptor = getBlockTermKeyDescriptorFromEvent(event, { macPlatform: isMacPlatform() });
      if (!descriptor) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      updateCommandKeys(recordingCommand, (keys) => (keys.includes(descriptor) ? keys : [...keys, descriptor]));
      setRecordingCommand(null);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, recordingCommand, updateCommandKeys]);

  const restoreDefaults = useCallback(() => {
    setBindings(copyBindings(getBlockTermKeymapDefaults()));
    setRecordingCommand(null);
  }, []);

  const save = useCallback(async () => {
    if (saving || !preview.valid) return;
    const serialized = serializeBlockTermKeymapBindings(createBlockTermKeymapOverrides(bindings));
    setSaving(true);
    try {
      await settingsApi.set(settingKey, serialized);
      useSettingsStore.setState((state) => ({
        settings: { ...state.settings, [settingKey]: serialized },
      }));
      const result = parseBlockTermKeymapConfig(serialized);
      setBindings(getBlockTermKeymapDisplayBindings(result.keymap));
      setInitialSerialized(serialized);
      setSourceInvalid(false);
      onSaved?.(serialized, result.keymap);
      toast.success(t("plugin.blockTerm.keymap.saved"));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("plugin.blockTerm.keymap.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [bindings, onOpenChange, onSaved, preview.valid, saving, settingKey, t]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && saving) return;
      onOpenChange(nextOpen);
    },
    [onOpenChange, saving]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-blockterm-keymap-dialog
        className="grid h-[min(88dvh,48rem)] grid-rows-[auto_auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-t-md p-0 md:max-w-4xl md:grid-rows-[auto_auto_minmax(0,1fr)_auto] md:rounded-md"
      >
        <DialogHeader data-blockterm-keymap-header className="border-b border-ide-border px-4 py-3 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-base text-ide-text">
            <Keyboard size={16} className="text-ide-accent" />
            {t("plugin.blockTerm.keymap.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("plugin.blockTerm.keymap.description")}</DialogDescription>
        </DialogHeader>

        <div
          data-blockterm-keymap-toolbar
          className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-ide-border px-3 py-2"
        >
          <div className="flex min-h-11 w-full items-stretch border border-ide-border bg-ide-bg p-0.5 md:h-8 md:min-h-0 md:w-auto md:items-center">
            {KEYMAP_SCOPES.map((item) => (
              <button
                key={item}
                type="button"
                data-blockterm-keymap-scope={item}
                aria-pressed={scope === item}
                className={`min-h-11 min-w-0 flex-1 px-2 text-xs transition-colors md:h-7 md:min-h-0 md:min-w-24 md:flex-none md:px-3 ${
                  scope === item ? "bg-ide-panel text-ide-accent" : "text-ide-mute hover:text-ide-text"
                }`}
                onClick={() => {
                  setScope(item);
                  setRecordingCommand(null);
                }}
              >
                {t(`plugin.blockTerm.keymap.${item}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-blockterm-keymap-restore
            className="flex min-h-11 w-full items-center justify-center gap-1.5 border border-ide-border px-2.5 text-xs text-ide-mute hover:bg-ide-bg hover:text-ide-text md:h-8 md:min-h-0 md:w-auto"
            onClick={restoreDefaults}
          >
            <RotateCcw size={13} />
            {t("plugin.blockTerm.keymap.restoreDefaults")}
          </button>
        </div>

        <div data-blockterm-keymap-list className="min-h-0 overflow-y-auto bg-ide-panel custom-scrollbar">
          {sourceInvalid && (
            <div className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/8 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              <CircleAlert size={14} className="mt-0.5 shrink-0" />
              <span>{t("plugin.blockTerm.keymap.invalidConfig")}</span>
            </div>
          )}
          {conflictCount > 0 && (
            <div className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/8 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              <CircleAlert size={14} className="mt-0.5 shrink-0" />
              <span>{interpolate(t("plugin.blockTerm.keymap.conflictSummary"), { count: conflictCount })}</span>
            </div>
          )}
          <div className="divide-y divide-ide-border">
            {definitions.map((definition) => {
              const binding = bindingsByCommand.get(definition.command);
              const keys = binding?.keys || [];
              const recording = recordingCommand === definition.command;
              const definitionLabel = getDefinitionLabel(definition, t);
              const maxKeysReached = keys.length >= BLOCKTERM_KEYMAP_MAX_KEYS_PER_BINDING;
              return (
                <div
                  key={definition.command}
                  className={`grid gap-2 px-3 py-3 md:grid-cols-[minmax(13rem,0.8fr)_minmax(0,1.2fr)] md:items-center ${
                    recording ? "bg-ide-accent/5" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ide-text">{definitionLabel}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-ide-mute">{definition.command}</div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 md:justify-end">
                    {keys.length === 0 && !recording && (
                      <span className="h-7 px-1.5 text-xs leading-7 text-ide-mute">
                        {t("plugin.blockTerm.keymap.unassigned")}
                      </span>
                    )}
                    {keys.map((key) => {
                      const conflict = conflictKeys.has(`${definition.command}\u0000${key}`);
                      return (
                        <span
                          key={key}
                          data-blockterm-keymap-key={key}
                          data-blockterm-keymap-conflict={conflict || undefined}
                          className={`inline-flex min-h-11 max-w-full items-center border bg-ide-bg font-mono text-xs md:h-7 md:min-h-0 ${
                            conflict
                              ? "border-amber-500 text-amber-600 dark:text-amber-400"
                              : "border-ide-border text-ide-text"
                          }`}
                          title={conflict ? t("plugin.blockTerm.keymap.conflict") : key}
                        >
                          <kbd className="max-w-48 truncate px-2 font-inherit">{key}</kbd>
                          <button
                            type="button"
                            className="flex h-11 w-11 shrink-0 items-center justify-center border-l border-inherit text-ide-mute hover:bg-ide-panel hover:text-red-500 md:h-full md:w-7"
                            title={t("plugin.blockTerm.keymap.removeKey")}
                            aria-label={`${t("plugin.blockTerm.keymap.removeKey")}: ${definitionLabel}, ${key}`}
                            onClick={() =>
                              updateCommandKeys(definition.command, (current) => current.filter((item) => item !== key))
                            }
                          >
                            <X size={12} />
                          </button>
                        </span>
                      );
                    })}
                    <button
                      type="button"
                      data-blockterm-keymap-record={definition.command}
                      aria-pressed={recording}
                      aria-label={`${recording ? t("plugin.blockTerm.keymap.recording") : t("plugin.blockTerm.keymap.record")}: ${definitionLabel}`}
                      title={maxKeysReached ? t("plugin.blockTerm.keymap.maxKeysReached") : undefined}
                      className={`flex min-h-11 shrink-0 items-center gap-1.5 border px-2 text-xs md:h-7 md:min-h-0 ${
                        recording
                          ? "border-ide-accent bg-ide-accent/10 text-ide-accent"
                          : "border-ide-border text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:cursor-not-allowed disabled:opacity-50"
                      }`}
                      disabled={maxKeysReached && !recording}
                      onClick={() =>
                        setRecordingCommand((current) => (current === definition.command ? null : definition.command))
                      }
                    >
                      <Keyboard size={12} />
                      {recording ? t("plugin.blockTerm.keymap.recording") : t("plugin.blockTerm.keymap.record")}
                    </button>
                    {recording && (
                      <span className="basis-full text-right text-[11px] text-ide-mute">
                        {t("plugin.blockTerm.keymap.recordHint")}
                      </span>
                    )}
                    {maxKeysReached && !recording && (
                      <span role="status" className="basis-full text-right text-[11px] text-ide-mute">
                        {t("plugin.blockTerm.keymap.maxKeysReached")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div
          data-blockterm-keymap-footer
          className="flex shrink-0 flex-col items-stretch gap-2 border-t border-ide-border bg-ide-panel px-4 py-3 md:flex-row md:items-center md:justify-end"
        >
          <button
            type="button"
            className="min-h-11 w-full border border-ide-border px-3 text-xs text-ide-mute hover:bg-ide-bg hover:text-ide-text disabled:opacity-50 md:h-8 md:min-h-0 md:w-auto"
            disabled={saving}
            onClick={() => handleOpenChange(false)}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-blockterm-keymap-save
            className="flex min-h-11 w-full min-w-20 items-center justify-center gap-1.5 bg-ide-accent px-3 text-xs text-ide-on-accent disabled:bg-ide-border disabled:text-ide-mute md:h-8 md:min-h-0 md:w-auto"
            disabled={saving || !dirty || !preview.valid}
            onClick={() => void save()}
          >
            {saving ? <LoaderCircle size={14} className="animate-spin" /> : <Save size={14} />}
            {t("common.save")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default BlockTermKeymapDialog;
