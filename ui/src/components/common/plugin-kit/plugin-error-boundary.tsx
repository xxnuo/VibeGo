import { Component, type ReactNode } from "react";
import { toast } from "sonner";
import { useAppStore } from "@/stores/app-store";
export class PluginErrorBoundary extends Component<{ pluginId: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const error = this.state.error;
    if (!error) return this.props.children;
    const en = useAppStore.getState().locale === "en";
    return (
      <div role="alert" className="m-3 border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-500">
        <p>
          {this.props.pluginId}: {error.message}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="min-h-11 rounded border border-ide-border px-3 text-ide-text md:min-h-7"
            onClick={() => this.setState({ error: null })}
          >
            {en ? "Retry" : "重试"}
          </button>
          <button
            type="button"
            className="min-h-11 rounded border border-ide-border px-3 text-ide-text md:min-h-7"
            onClick={() => {
              void navigator.clipboard.writeText(`${this.props.pluginId}\n${error.stack || error.message}`).then(
                () => toast.info(en ? "Diagnostics copied" : "已复制诊断信息"),
                (error) => toast.error(String(error))
              );
            }}
          >
            {en ? "Report" : "报告"}
          </button>
        </div>
      </div>
    );
  }
}
