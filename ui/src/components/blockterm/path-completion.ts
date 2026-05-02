import type { FileInfo } from "@/api/file";
import { commonPrefix } from "../terminal/blockterm-command-completion.ts";
import {
  applyBlockTermCompletion,
  type BlockTermCompletionContext,
  parseBlockTermCompletionContext,
  resolveBlockTermCompletion,
} from "../terminal/blockterm-model.ts";

export interface PathCompletionContext {
  editor: BlockTermCompletionContext;
  directory: string;
  prefix: string;
  fragment: string;
}

// Reuse shell-aware edits, not the legacy terminal UI or runtime.
export function pathCompletionContext(
  text: string,
  cursor: number,
  cwd: string,
  shell: string
): PathCompletionContext | null {
  if (!/^(bash|zsh)$/.test(shell.split(/[\\/]/).pop() ?? "") || !cwd.startsWith("/")) return null;
  // Earlier compound commands may change cwd before this argument is evaluated.
  if (/[;|&\n\r`()<>]/.test(text)) return null;
  const editor = parseBlockTermCompletionContext(text, cursor);
  if (
    !editor ||
    editor.kind !== "file" ||
    editor.executableOnly ||
    editor.hasContentSuffix ||
    !/^(?:\.{1,2}\/|\/)/.test(editor.prefix)
  )
    return null;
  const split = editor.prefix.lastIndexOf("/") + 1;
  const prefix = editor.prefix.slice(0, split);
  return {
    editor,
    directory: prefix.startsWith("/") ? prefix : `${cwd.replace(/\/$/, "")}/${prefix}`,
    prefix,
    fragment: editor.prefix.slice(split),
  };
}

export interface PathCandidate {
  label: string;
  value: string;
  directory: boolean;
}

export function pathCandidates(
  context: PathCompletionContext,
  files: Pick<FileInfo, "name" | "isDir">[]
): PathCandidate[] {
  return files
    .filter(
      (file) =>
        file.name.startsWith(context.fragment) &&
        ![...file.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
        (context.fragment.startsWith(".") || !file.name.startsWith("."))
    )
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    .slice(0, 200)
    .map((file) => {
      const value = context.prefix + file.name + (file.isDir ? "/" : "");
      return { label: file.name + (file.isDir ? "/" : ""), value, directory: file.isDir };
    });
}

export function applyPathCandidate(context: Pick<PathCompletionContext, "editor">, candidate: PathCandidate) {
  return applyBlockTermCompletion(context.editor, candidate.value, true, candidate.directory);
}

export function explicitCompletionEdit(context: Pick<PathCompletionContext, "editor">, items: PathCandidate[]) {
  if (!items.length || items.length >= 200) return null;
  return resolveBlockTermCompletion(
    context.editor,
    items.map((item) => ({
      value: item.value,
      display: item.label,
      isDirectory: item.directory,
    })),
    commonPrefix(items.map((item) => item.value))
  ).edit;
}
