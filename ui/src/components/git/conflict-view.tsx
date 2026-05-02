import { DiffEditor } from "@monaco-editor/react";
import { AlertTriangle, Check, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { GitConflictResolveMode, GitConflictStages } from "@/api/git";
import { gitApi } from "@/api/git";
import { buildConflictDocuments } from "@/components/git/conflict-utils";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Locale } from "@/stores";
import "@/lib/monaco";
import { useAppStore } from "@/stores/app-store";

interface ConflictViewProps {
  repoPath: string;
  filePath: string;
  locale: Locale;
  onResolve: (
    content: string,
    hash: string,
    mode?: Exclude<GitConflictResolveMode, "line-map">
  ) => boolean | Promise<boolean>;
  onCancel: () => void;
}

const i18n = {
  en: {
    title: "Resolve Conflict",
    ours: "Ours (Current)",
    theirs: "Theirs (Incoming)",
    resolved: "Resolved",
    accept: "Accept Resolution",
    cancel: "Cancel",
    loading: "Loading...",
    loadError: "Failed to load conflict details",
    useOurs: "Use Ours",
    useTheirs: "Use Theirs",
    deleteOurs: "Delete Ours",
    deleteTheirs: "Delete Theirs",
  },
  zh: {
    title: "解决冲突",
    ours: "我们的 (当前)",
    theirs: "他们的 (传入)",
    resolved: "已解决",
    accept: "接受解决",
    cancel: "取消",
    loading: "加载中...",
    loadError: "加载冲突详情失败",
    useOurs: "使用我们的",
    useTheirs: "使用他们的",
    deleteOurs: "删除我们的版本",
    deleteTheirs: "删除传入版本",
  },
};

const getLanguageFromFilename = (filename?: string): string => {
  if (!filename) return "plaintext";
  const ext = filename.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    go: "go",
    py: "python",
  };
  return langMap[ext || ""] || "plaintext";
};

const ConflictView: React.FC<ConflictViewProps> = ({ repoPath, filePath, locale, onResolve, onCancel }) => {
  const t = i18n[locale] || i18n.en;
  const appTheme = useAppStore((s) => s.theme);
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [conflictHash, setConflictHash] = useState("");
  const [ours, setOurs] = useState("");
  const [theirs, setTheirs] = useState("");
  const [resolved, setResolved] = useState("");
  const [stages, setStages] = useState<GitConflictStages | undefined>();
  const [activeTab, setActiveTab] = useState<"compare" | "edit">("compare");
  const compareModelIdRef = useRef(`git-conflict-compare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const editModelIdRef = useRef(`git-conflict-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const compareTabRef = useRef<HTMLButtonElement | null>(null);
  const editTabRef = useRef<HTMLButtonElement | null>(null);
  const initialFocusDoneRef = useRef(false);

  const compareTabId = `${compareModelIdRef.current}-tab`;
  const editTabId = `${editModelIdRef.current}-tab`;
  const panelId = `${compareModelIdRef.current}-panel`;

  const editorTheme = useMemo(() => {
    return appTheme === "light" ? "light" : "vs-dark";
  }, [appTheme]);

  const language = getLanguageFromFilename(filePath);
  const filename = filePath.split("/").pop() || filePath;

  useEffect(() => {
    const loadContent = async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const details = await gitApi.conflictDetails(repoPath, filePath);
        const documents = buildConflictDocuments(details.segments || []);
        setOurs(documents.ours);
        setTheirs(documents.theirs);
        // In a modify/delete conflict the deleted side is empty. Start the
        // editor with the surviving side so accepting without another click
        // cannot accidentally create an empty file.
        const initialResolved = details.stages?.ours.deleted ? documents.theirs : documents.ours;
        setResolved(initialResolved);
        setConflictHash(details.hash || "");
        setStages(details.stages);
      } catch (err) {
        console.error("Failed to load conflict file:", err);
        setConflictHash("");
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    };
    loadContent();
  }, [repoPath, filePath]);

  useEffect(() => {
    if (loading || loadError || initialFocusDoneRef.current) return;
    initialFocusDoneRef.current = true;
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body || !active.isConnected) {
        compareTabRef.current?.focus();
      }
    });
  }, [loading, loadError]);

  const handleModeTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextTab = event.key === "ArrowRight" ? "edit" : "compare";
    setActiveTab(nextTab);
    window.requestAnimationFrame(() => {
      (nextTab === "compare" ? compareTabRef : editTabRef).current?.focus();
    });
  };

  const handleUseOurs = () => {
    if (stages?.ours.deleted) {
      void handleResolve("", "delete");
      return;
    }
    setResolved(ours);
    setActiveTab("edit");
  };

  const handleUseTheirs = () => {
    if (stages?.theirs.deleted) {
      void handleResolve("", "delete");
      return;
    }
    setResolved(theirs);
    setActiveTab("edit");
  };

  const handleResolve = async (content: string, mode: Exclude<GitConflictResolveMode, "line-map"> = "manual") => {
    if (!conflictHash) return;
    const ok = await onResolve(content, conflictHash, mode);
    if (ok) onCancel();
  };

  const handleAccept = async () => {
    await handleResolve(resolved, "manual");
  };

  const bothSidesDeleted = Boolean(stages?.ours.deleted && stages?.theirs.deleted);

  if (loading) {
    return <div className="h-full flex items-center justify-center text-ide-mute">{t.loading}</div>;
  }
  if (loadError) {
    return <div className="h-full flex items-center justify-center text-ide-mute">{t.loadError}</div>;
  }

  return (
    <div className="flex h-full flex-col bg-ide-bg" role="region" aria-label={t.title}>
      <div
        className={`border-b border-ide-border bg-ide-panel/50 px-3 py-2 ${
          isMobile ? "flex flex-col gap-2" : "flex items-center justify-between"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <AlertTriangle size={16} className="shrink-0 text-yellow-500" />
          <span className="min-w-0 truncate text-sm font-medium text-ide-text" title={filename}>
            {filename}
          </span>
          <span className="shrink-0 text-xs text-ide-mute">{t.title}</span>
        </div>
        <div className={isMobile ? "grid grid-cols-2 gap-2" : "flex items-center gap-2"}>
          <button
            onClick={handleUseOurs}
            className={`bg-blue-500/20 px-2 text-xs text-blue-400 hover:bg-blue-500/30 ${
              isMobile ? "min-h-11 min-w-0 rounded-sm py-2 leading-tight" : "rounded py-1"
            }`}
          >
            {stages?.ours.deleted ? t.deleteOurs : t.useOurs}
          </button>
          <button
            onClick={handleUseTheirs}
            className={`bg-green-500/20 px-2 text-xs text-green-400 hover:bg-green-500/30 ${
              isMobile ? "min-h-11 min-w-0 rounded-sm py-2 leading-tight" : "rounded py-1"
            }`}
          >
            {stages?.theirs.deleted ? t.deleteTheirs : t.useTheirs}
          </button>
        </div>
      </div>

      <div className="flex border-b border-ide-border" role="tablist" aria-label={t.title}>
        <button
          type="button"
          ref={compareTabRef}
          id={compareTabId}
          role="tab"
          aria-selected={activeTab === "compare"}
          aria-controls={panelId}
          tabIndex={activeTab === "compare" ? 0 : -1}
          onClick={() => setActiveTab("compare")}
          onKeyDown={handleModeTabKeyDown}
          className={`${isMobile ? "min-h-11 flex-1 truncate px-2" : "px-4 py-2"} text-xs font-medium transition-colors ${
            activeTab === "compare"
              ? "text-ide-accent border-b-2 border-ide-accent"
              : "text-ide-mute hover:text-ide-text"
          }`}
        >
          {t.ours} vs {t.theirs}
        </button>
        <button
          type="button"
          ref={editTabRef}
          id={editTabId}
          role="tab"
          aria-selected={activeTab === "edit"}
          aria-controls={panelId}
          tabIndex={activeTab === "edit" ? 0 : -1}
          onClick={() => setActiveTab("edit")}
          onKeyDown={handleModeTabKeyDown}
          className={`${isMobile ? "min-h-11 flex-1 truncate px-2" : "px-4 py-2"} text-xs font-medium transition-colors ${
            activeTab === "edit" ? "text-ide-accent border-b-2 border-ide-accent" : "text-ide-mute hover:text-ide-text"
          }`}
        >
          {t.resolved}
        </button>
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={activeTab === "compare" ? compareTabId : editTabId}
        className="flex-1 overflow-hidden"
      >
        {activeTab === "compare" ? (
          <DiffEditor
            original={ours}
            modified={theirs}
            language={language}
            theme={editorTheme}
            keepCurrentOriginalModel={true}
            keepCurrentModifiedModel={true}
            originalModelPath={`${compareModelIdRef.current}-original`}
            modifiedModelPath={`${compareModelIdRef.current}-modified`}
            options={{
              readOnly: true,
              renderSideBySide: !isMobile,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              automaticLayout: true,
            }}
          />
        ) : (
          <DiffEditor
            original={ours}
            modified={resolved}
            language={language}
            theme={editorTheme}
            keepCurrentOriginalModel={true}
            keepCurrentModifiedModel={true}
            originalModelPath={`${editModelIdRef.current}-original`}
            modifiedModelPath={`${editModelIdRef.current}-modified`}
            onMount={(editor) => {
              const modifiedEditor = editor.getModifiedEditor();
              modifiedEditor.onDidChangeModelContent(() => {
                setResolved(modifiedEditor.getValue());
              });
            }}
            options={{
              readOnly: false,
              originalEditable: false,
              renderSideBySide: !isMobile,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              automaticLayout: true,
            }}
          />
        )}
      </div>

      <div
        className={`gap-2 border-t border-ide-border bg-ide-panel/30 px-3 ${
          isMobile
            ? "grid grid-cols-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
            : "flex items-center justify-end py-2"
        }`}
      >
        <button
          type="button"
          onClick={onCancel}
          className={`flex items-center justify-center gap-1 px-4 text-sm text-ide-mute hover:text-ide-text ${
            isMobile ? "min-h-11 py-2" : "py-1.5"
          }`}
        >
          <X size={14} />
          {t.cancel}
        </button>
        <button
          onClick={() => void handleAccept()}
          disabled={!conflictHash || bothSidesDeleted}
          className={`flex items-center justify-center gap-1 bg-ide-accent px-4 text-sm text-ide-bg hover:bg-ide-accent/80 disabled:cursor-not-allowed disabled:opacity-50 ${
            isMobile ? "min-h-11 rounded-sm py-2" : "rounded py-1.5"
          }`}
        >
          <Check size={14} />
          {t.accept}
        </button>
      </div>
    </div>
  );
};

export default ConflictView;
