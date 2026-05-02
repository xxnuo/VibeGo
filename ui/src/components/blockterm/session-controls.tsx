import type { Session } from "./api";

export function SessionControls({
  sessions,
  selectedId,
  shell,
  onSelect,
  onShellChange,
}: {
  sessions: Session[];
  selectedId: string;
  shell: string;
  onSelect: (id: string) => void;
  onShellChange: (shell: string) => void;
}) {
  return (
    <div data-blockterm-session-controls className="flex h-11 min-w-0 flex-1 items-center gap-2 text-ide-text">
      <select
        aria-label="终端会话"
        className="h-11 min-w-0 flex-1 bg-transparent text-sm"
        value={selectedId}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="" disabled>
          块终端
        </option>
        {sessions.map((item) => (
          <option key={item.id} value={item.id}>
            {item.shell.split(/[\\/]/).pop()} · {item.cwd}
            {item.phase === "exited"
              ? " · 已结束"
              : item.phase === "running" || item.phase === "submitted"
                ? " · 运行中"
                : ""}
          </option>
        ))}
      </select>
      <select
        aria-label="新会话 Shell"
        className="h-11 w-24 shrink-0 bg-transparent text-sm"
        value={shell}
        onChange={(event) => onShellChange(event.target.value)}
      >
        <option value="">默认 Shell</option>
        {["bash", "zsh", "fish", "pwsh", "powershell"].map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}
