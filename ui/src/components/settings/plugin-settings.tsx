import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createPluginStorage } from "@/framework/host/storage-service";
import { useWorkbenchRegistry } from "@/framework/workbench/registry";
import { useAppStore } from "@/stores/app-store";
import { useFrameStore } from "@/stores/frame-store";
import { useSessionStore } from "@/stores/session-store";
export default function PluginSettings() {
  const registry = useWorkbenchRegistry();
  const groups = useFrameStore((state) => state.groups);
  const sessionId = useSessionStore((state) => state.currentSessionId) || "local";
  const en = useAppStore((state) => state.locale === "en");
  const workspaces = groups.filter(
    (group) => group.type === "group" && group.pages.some((page) => page.type === "files" && page.path)
  );
  const [workspace, setWorkspace] = useState(workspaces[0]?.id || "");
  useEffect(() => {
    if (!workspaces.some((group) => group.id === workspace)) setWorkspace(workspaces[0]?.id || "");
  }, [groups, workspace]);
  const [, refresh] = useState(0);
  useEffect(() => {
    const update = () => refresh((value) => value + 1);
    window.addEventListener("storage", update);
    window.addEventListener("plugin-storage-change", update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("plugin-storage-change", update);
    };
  }, []);
  return (
    <div className="space-y-3">
      {workspaces.length > 0 && (
        <select
          aria-label={en ? "Workspace" : "工作区"}
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
          className="min-h-11 w-full rounded border border-ide-border bg-ide-panel px-2 text-xs md:min-h-8"
        >
          {workspaces.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      )}
      {registry
        .getPlugins()
        .filter((plugin) => plugin.contributions?.configuration)
        .map((plugin) => (
          <section key={plugin.id} className="border-b border-ide-border pb-3">
            <h3 className="mb-2 text-xs font-medium">{plugin.contributions!.configuration!.title || plugin.name}</h3>
            {Object.entries(plugin.contributions!.configuration!.properties).map(([key, schema]) => {
              const storage = createPluginStorage(
                plugin.id,
                schema.scope === "workspace" ? `${sessionId}:${workspace}` : undefined
              );
              const value = storage.get<string | number | boolean>(key, schema.default);
              const update = async (value: string | number | boolean) => {
                try {
                  await storage.update(key, value);
                } catch (error) {
                  toast.error(String(error));
                }
              };
              const disabled = schema.scope === "workspace" && !workspace;
              return (
                <label
                  key={key}
                  className="flex min-h-11 items-center justify-between gap-3 border-b border-ide-border py-2 text-xs"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block">{schema.title || key}</span>
                    {schema.description && <span className="block text-ide-mute">{schema.description}</span>}
                  </span>
                  {schema.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      disabled={disabled}
                      onChange={(event) => void update(event.target.checked)}
                      className="accent-ide-accent"
                    />
                  ) : schema.enum ? (
                    <select
                      aria-label={schema.title || key}
                      disabled={disabled}
                      value={String(value ?? "")}
                      onChange={(event) =>
                        void update(schema.type === "number" ? Number(event.target.value) : event.target.value)
                      }
                      className="min-h-11 max-w-[55%] rounded border border-ide-border bg-ide-panel px-2 md:min-h-8"
                    >
                      {schema.enum.map((option) => (
                        <option key={String(option)} value={String(option)}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={schema.title || key}
                      disabled={disabled}
                      type={schema.secret ? "password" : schema.type === "number" ? "number" : "text"}
                      value={String(value ?? "")}
                      min={schema.minimum}
                      max={schema.maximum}
                      onChange={(event) => {
                        const next = schema.type === "number" ? Number(event.target.value) : event.target.value;
                        if (
                          typeof next === "number" &&
                          (!Number.isFinite(next) ||
                            next < (schema.minimum ?? -Infinity) ||
                            next > (schema.maximum ?? Infinity))
                        )
                          return;
                        void update(next);
                      }}
                      className="min-h-11 w-40 max-w-[55%] rounded border border-ide-border bg-ide-panel px-2 md:min-h-8"
                    />
                  )}
                </label>
              );
            })}
          </section>
        ))}
    </div>
  );
}
