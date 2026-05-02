import { Bot, KeyRound, Loader2, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { type BlockTermModelConfig, blockTermModelApi } from "@/api/blockterm-model";

interface BlockTermModelSettingsProps {
  t: (key: string) => string;
}

interface ModelConfigForm {
  baseUrl: string;
  model: string;
  maxTokens: string;
  timeoutSeconds: string;
  allowPrivateNetwork: boolean;
  apiToken: string;
  apiTokenSet: boolean;
}

function configToForm(config: BlockTermModelConfig): ModelConfigForm {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    maxTokens: String(config.maxTokens),
    timeoutSeconds: String(config.timeoutSeconds),
    allowPrivateNetwork: config.allowPrivateNetwork,
    apiToken: "",
    apiTokenSet: config.apiTokenSet,
  };
}

const inputClass =
  "h-11 w-full rounded border border-ide-border bg-ide-panel px-3 text-base text-ide-text placeholder:text-ide-mute focus:border-ide-accent focus:outline-none md:h-8 md:text-sm";

export const BlockTermModelSettings: React.FC<BlockTermModelSettingsProps> = ({ t }) => {
  const [form, setForm] = useState<ModelConfigForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tokenDirty, setTokenDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setForm(configToForm(await blockTermModelApi.getConfig()));
      setTokenDirty(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.modelConfig.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!form || saving) return;
    const maxTokens = Number(form.maxTokens);
    const timeoutSeconds = Number(form.timeoutSeconds);
    if (!Number.isInteger(maxTokens) || !Number.isInteger(timeoutSeconds)) {
      toast.error(t("settings.modelConfig.invalidNumbers"));
      return;
    }
    setSaving(true);
    try {
      const config = await blockTermModelApi.updateConfig({
        baseUrl: form.baseUrl,
        model: form.model,
        maxTokens,
        timeoutSeconds,
        allowPrivateNetwork: form.allowPrivateNetwork,
        ...(tokenDirty ? { apiToken: form.apiToken } : {}),
      });
      setForm(configToForm(config));
      setTokenDirty(false);
      toast.success(t("settings.modelConfig.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.modelConfig.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (saving) return;
    setSaving(true);
    try {
      setForm(configToForm(await blockTermModelApi.resetConfig()));
      setTokenDirty(false);
      toast.success(t("settings.modelConfig.resetDone"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.modelConfig.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const clearToken = async () => {
    if (!form || saving) return;
    setSaving(true);
    try {
      const config = await blockTermModelApi.updateConfig({ apiToken: "" });
      setForm(configToForm(config));
      setTokenDirty(false);
      toast.success(t("settings.modelConfig.tokenCleared"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.modelConfig.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (loading || !form) {
    return (
      <div className="flex min-h-32 items-center justify-center border border-ide-border bg-ide-bg text-ide-mute">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  return (
    <section className="border border-ide-border bg-ide-bg">
      <div className="flex items-start justify-between gap-3 border-b border-ide-border p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Bot size={18} className="mt-0.5 shrink-0 text-ide-mute" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-ide-text">{t("settings.modelConfig.title")}</h2>
            <p className="text-xs leading-5 text-ide-mute">{t("settings.modelConfig.description")}</p>
          </div>
        </div>
        <button
          type="button"
          className="flex size-11 shrink-0 items-center justify-center border border-ide-border text-ide-mute hover:border-ide-accent hover:text-ide-text disabled:opacity-50 md:size-8"
          onClick={() => void load()}
          disabled={saving}
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="grid gap-4 p-4">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-ide-text">{t("settings.modelConfig.baseUrl")}</span>
          <input
            className={inputClass}
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            autoComplete="url"
            spellCheck={false}
          />
          <span className="text-xs leading-5 text-ide-mute">{t("settings.modelConfig.baseUrlDescription")}</span>
        </label>

        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-ide-text">{t("settings.modelConfig.model")}</span>
          <input
            className={inputClass}
            value={form.model}
            onChange={(event) => setForm({ ...form, model: event.target.value })}
            spellCheck={false}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-ide-text">{t("settings.modelConfig.maxTokens")}</span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={1048576}
              step={1}
              value={form.maxTokens}
              onChange={(event) => setForm({ ...form, maxTokens: event.target.value })}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-ide-text">{t("settings.modelConfig.timeout")}</span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={3600}
              step={1}
              value={form.timeoutSeconds}
              onChange={(event) => setForm({ ...form, timeoutSeconds: event.target.value })}
            />
          </label>
        </div>

        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="blockterm-model-token"
              className="flex items-center gap-2 text-xs font-medium text-ide-text"
            >
              <KeyRound size={14} className="text-ide-mute" />
              {t("settings.modelConfig.token")}
            </label>
            {form.apiTokenSet && (
              <button
                type="button"
                className="flex size-11 items-center justify-center text-ide-mute hover:bg-ide-panel hover:text-red-500 disabled:opacity-50 md:size-7"
                onClick={() => void clearToken()}
                disabled={saving}
                title={t("settings.modelConfig.clearToken")}
                aria-label={t("settings.modelConfig.clearToken")}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <input
            id="blockterm-model-token"
            className={inputClass}
            type="password"
            value={form.apiToken}
            placeholder={
              form.apiTokenSet ? t("settings.modelConfig.tokenConfigured") : t("settings.modelConfig.tokenPlaceholder")
            }
            onChange={(event) => {
              setForm({ ...form, apiToken: event.target.value });
              setTokenDirty(true);
            }}
            autoComplete="new-password"
          />
          <span className="text-xs leading-5 text-ide-mute">{t("settings.modelConfig.tokenDescription")}</span>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-ide-border pt-4">
          <div className="min-w-0">
            <div className="text-xs font-medium text-ide-text">{t("settings.modelConfig.allowPrivate")}</div>
            <div className="text-xs leading-5 text-ide-mute">{t("settings.modelConfig.allowPrivateDescription")}</div>
          </div>
          <button
            type="button"
            aria-pressed={form.allowPrivateNetwork}
            aria-label={t("settings.modelConfig.allowPrivate")}
            onClick={() => setForm({ ...form, allowPrivateNetwork: !form.allowPrivateNetwork })}
            className="group inline-flex h-11 w-14 shrink-0 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ide-accent md:h-7 md:w-12"
          >
            <span
              aria-hidden="true"
              className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors duration-200 ${
                form.allowPrivateNetwork
                  ? "border-ide-accent bg-ide-accent/12"
                  : "border-ide-border bg-ide-panel group-hover:border-ide-mute/40"
              }`}
            >
              <span
                className={`absolute left-0.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full border shadow-sm transition-all duration-200 ${
                  form.allowPrivateNetwork
                    ? "translate-x-5 border-ide-accent bg-ide-accent"
                    : "translate-x-0 border-ide-border bg-white"
                }`}
              />
            </span>
          </button>
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-ide-border p-4 sm:flex-row sm:justify-end">
        <button
          type="button"
          className="inline-flex min-h-11 items-center justify-center gap-2 border border-ide-border bg-ide-panel px-3 text-xs text-ide-text hover:border-ide-accent disabled:opacity-50 md:min-h-8"
          onClick={() => void reset()}
          disabled={saving}
        >
          <RotateCcw size={14} />
          {t("settings.modelConfig.reset")}
        </button>
        <button
          type="button"
          className="inline-flex min-h-11 items-center justify-center gap-2 border border-ide-accent bg-ide-accent px-3 text-xs text-ide-bg hover:opacity-90 disabled:opacity-50 md:min-h-8"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {t("settings.modelConfig.save")}
        </button>
      </div>
    </section>
  );
};
