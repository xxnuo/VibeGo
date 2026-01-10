import { create } from 'zustand';

export interface GitFileNode {
  id: string;
  name: string;
  status: 'modified' | 'added' | 'deleted';
  path: string;
  originalContent?: string;
  modifiedContent?: string;
}

interface GitState {
  repoId: string | null;
  files: GitFileNode[];
  currentBranch: string;
  branches: string[];
  commitMessage: string;
  isLoading: boolean;

  setRepoId: (id: string | null) => void;
  setFiles: (files: GitFileNode[]) => void;
  setCurrentBranch: (branch: string) => void;
  setBranches: (branches: string[]) => void;
  setCommitMessage: (msg: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useGitStore = create<GitState>((set) => ({
  repoId: null,
  files: [],
  currentBranch: 'main',
  branches: [],
  commitMessage: '',
  isLoading: false,

  setRepoId: (id) => set({ repoId: id }),
  setFiles: (files) => set({ files }),
  setCurrentBranch: (branch) => set({ currentBranch: branch }),
  setBranches: (branches) => set({ branches }),
  setCommitMessage: (msg) => set({ commitMessage: msg }),
  setLoading: (loading) => set({ isLoading: loading }),
}));
