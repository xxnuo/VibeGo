import type { GitCommit, GitDiff, GitSubmoduleStatus } from "@/api/git";

export type { GitCommit, GitDiff };

export interface GitFileNode {
  id: string;
  name: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked";
  path: string;
  staged: boolean;
  originalContent?: string;
  modifiedContent?: string;
  submodule?: GitSubmoduleStatus;
}
