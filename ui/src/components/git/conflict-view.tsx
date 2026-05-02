import { DiffEditor } from "@monaco-editor/react";
import { AlertTriangle, Check, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { GitConflictResolveMode, GitConflictStages } from "@/api/git";
import { gitApi } from "@/api/git";
import { buildConflictDocuments } from "@/components/git/conflict-utils";
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
    <div className="h-full flex flex-col bg-ide-bg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-ide-border bg-ide-panel/50">
        <div className="flex items-center gap-2">
          <AlertTriangle size={16} className="text-yellow-500" />
          <span className="text-sm font-medium text-ide-text">{filename}</span>
          <span className="text-xs text-ide-mute">{t.title}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleUseOurs}
            className="px-2 py-1 text-xs bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30"
          >
            {stages?.ours.deleted ? t.deleteOurs : t.useOurs}
          </button>
          <button
            onClick={handleUseTheirs}
            className="px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30"
          >
            {stages?.theirs.deleted ? t.deleteTheirs : t.useTheirs}
          </button>
        </div>
      </div>

      <div className="flex border-b border-ide-border">
        <button
          onClick={() => setActiveTab("compare")}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            activeTab === "compare"
              ? "text-ide-accent border-b-2 border-ide-accent"
              : "text-ide-mute hover:text-ide-text"
          }`}
        >
          {t.ours} vs {t.theirs}
        </button>
        <button
          onClick={() => setActiveTab("edit")}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            activeTab === "edit" ? "text-ide-accent border-b-2 border-ide-accent" : "text-ide-mute hover:text-ide-text"
          }`}
        >
          {t.resolved}
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
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
              renderSideBySide: true,
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
              renderSideBySide: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: 13,
              automaticLayout: true,
            }}
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-ide-border bg-ide-panel/30">
        <button
          onClick={onCancel}
          className="px-4 py-1.5 text-sm text-ide-mute hover:text-ide-text flex items-center gap-1"
        >
          <X size={14} />
          {t.cancel}
        </button>
        <button
          onClick={() => void handleAccept()}
          disabled={!conflictHash || bothSidesDeleted}
          className="px-4 py-1.5 text-sm bg-ide-accent text-ide-bg rounded flex items-center gap-1 hover:bg-ide-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check size={14} />
          {t.accept}
        </button>
      </div>
    </div>
  );
};

export default ConflictView;
