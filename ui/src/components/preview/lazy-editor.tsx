import type { DiffEditorProps, EditorProps } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense } from "react";
import { useTranslation } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";

const Editor = lazy(async () => {
  await import("@/lib/monaco");
  return import("@monaco-editor/react");
});

const DiffEditor = lazy(async () => {
  await import("@/lib/monaco");
  const module = await import("@monaco-editor/react");
  return { default: module.DiffEditor };
});

class EditorErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function EditorLoadError() {
  const locale = useAppStore((state) => state.locale);
  const t = useTranslation(locale);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-4 text-sm text-ide-mute" role="alert">
      <span>{t("preview.editorLoadFailed")}</span>
      <button
        type="button"
        className="rounded border border-ide-border px-3 py-2 text-ide-text hover:bg-ide-panel"
        onClick={() => window.location.reload()}
      >
        {t("common.refresh")}
      </button>
    </div>
  );
}

function EditorLoading() {
  return (
    <div className="h-full flex items-center justify-center text-ide-mute" role="status">
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}

export default function LazyEditor(props: EditorProps) {
  return (
    <EditorErrorBoundary fallback={<EditorLoadError />}>
      <Suspense fallback={props.loading ?? <EditorLoading />}>
        <Editor {...props} />
      </Suspense>
    </EditorErrorBoundary>
  );
}

export function LazyDiffEditor(props: DiffEditorProps) {
  return (
    <EditorErrorBoundary fallback={<EditorLoadError />}>
      <Suspense fallback={props.loading ?? <EditorLoading />}>
        <DiffEditor {...props} />
      </Suspense>
    </EditorErrorBoundary>
  );
}
