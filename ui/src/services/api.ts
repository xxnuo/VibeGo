import type { FileNode, GitFileNode, TerminalSession } from "@/stores";

const API_BASE = "/api";

interface BackendFile {
  name: string;
  path: string;
  is_dir: boolean;
  children?: BackendFile[];
  size?: number;
  mod_time?: number;
}

const IGNORED_FILES = new Set([
  ".DS_Store",
  ".git",
  "__MACOSX",
  "node_modules",
  "dist",
  ".idea",
  ".vscode",
]);

const isIgnored = (name: string) => {
  return IGNORED_FILES.has(name) || name.startsWith("._");
};

export const getFileTree = async (path: string = "."): Promise<FileNode[]> => {
  const res = await fetch(
    `${API_BASE}/file/tree?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error("Failed to fetch file tree");
  const root: BackendFile = await res.json();

  const transform = (node: BackendFile): FileNode | null => {
    if (isIgnored(node.name)) return null;

    const children = node.children
      ? node.children.map(transform).filter((n): n is FileNode => n !== null)
      : undefined;

    return {
      id: node.path,
      name: node.name,
      type: node.is_dir ? "folder" : "file",
      children,
      language: node.is_dir ? undefined : guessLanguage(node.name),
    };
  };

  if (path === "." && root.children) {
    return root.children
      .map(transform)
      .filter((n): n is FileNode => n !== null);
  }

  const transformedRoot = transform(root);
  return transformedRoot ? [transformedRoot] : [];
};

export const readFile = async (path: string): Promise<string> => {
  const res = await fetch(
    `${API_BASE}/file/read?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error("Failed to read file");
  const data = await res.json();
  return data.content || "";
};

export const writeFile = async (
  path: string,
  content: string,
): Promise<void> => {
  const res = await fetch(`${API_BASE}/file/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) throw new Error("Failed to write file");
};

interface GitStatusResponse {
  files: {
    path: string;
    status: string;
    staged: boolean;
  }[];
}

export const getGitStatus = async (
  repoPath: string,
): Promise<GitFileNode[]> => {
  const res = await fetch(`${API_BASE}/git/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: repoPath }),
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data: GitStatusResponse = await res.json();

  return data.files
    .filter((f) => !isIgnored(f.path.split("/").pop() || ""))
    .map((f, idx) => ({
      id: `git-${idx}`,
      name: f.path.split("/").pop() || f.path,
      path: f.path,
      status: mapGitStatus(f.status),
      staged: f.staged,
    }));
};

export const getGitDiff = async (
  repoPath: string,
  filePath: string,
): Promise<{ old: string; new: string }> => {
  const res = await fetch(`${API_BASE}/git/diff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: repoPath, filePath }),
  });
  if (!res.ok) return { old: "", new: "" };
  return await res.json();
};

export const stageFile = async (
  repoPath: string,
  files: string[],
): Promise<void> => {
  await fetch(`${API_BASE}/git/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: repoPath, files }),
  });
};

export const unstageFile = async (repoPath: string): Promise<void> => {
  await fetch(`${API_BASE}/git/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: repoPath }),
  });
};

export const commitChanges = async (
  repoPath: string,
  message: string,
): Promise<void> => {
  await fetch(`${API_BASE}/git/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: repoPath, message }),
  });
};

const mapGitStatus = (s: string): "modified" | "added" | "deleted" => {
  if (s.includes("M")) return "modified";
  if (s.includes("A") || s.includes("?")) return "added";
  if (s.includes("D")) return "deleted";
  return "modified";
};

export const getTerminals = async (): Promise<TerminalSession[]> => {
  const res = await fetch(`${API_BASE}/terminal`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.terminals.map((t: any) => ({
    id: t.id,
    name: t.name || "Terminal",
    history: [],
  }));
};

export const createTerminal = async (): Promise<TerminalSession> => {
  const res = await fetch(`${API_BASE}/terminal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Terminal", cols: 80, rows: 24 }),
  });
  if (!res.ok) throw new Error("Failed to create terminal");
  const data = await res.json();
  return {
    id: data.id,
    name: data.name || "Terminal",
    history: [],
  };
};

export const closeTerminal = async (id: string): Promise<void> => {
  await fetch(`${API_BASE}/terminal/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
};

export const getTerminalWsUrl = (id: string) => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/terminal/ws/${id}`;
};

function guessLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "html":
      return "html";
    case "css":
      return "css";
    case "md":
      return "markdown";
    case "go":
      return "go";
    case "py":
      return "python";
    case "java":
      return "java";
    default:
      return "plaintext";
  }
}
