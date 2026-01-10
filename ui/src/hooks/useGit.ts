import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { gitApi } from '@/api/git';
import { useGitStore } from '@/stores';

export const gitKeys = {
  all: ['git'] as const,
  repos: () => [...gitKeys.all, 'repos'] as const,
  status: (id: string) => [...gitKeys.all, 'status', id] as const,
  log: (id: string) => [...gitKeys.all, 'log', id] as const,
  diff: (id: string, path: string) => [...gitKeys.all, 'diff', id, path] as const,
};

export function useGitRepos() {
  return useQuery({
    queryKey: gitKeys.repos(),
    queryFn: () => gitApi.list(),
  });
}

export function useGitStatus(id: string | null) {
  return useQuery({
    queryKey: gitKeys.status(id || ''),
    queryFn: () => gitApi.status(id!),
    enabled: !!id,
  });
}

export function useGitLog(id: string | null, limit = 20) {
  return useQuery({
    queryKey: gitKeys.log(id || ''),
    queryFn: () => gitApi.log(id!, limit),
    enabled: !!id,
  });
}

export function useGitDiff(id: string | null, path: string) {
  return useQuery({
    queryKey: gitKeys.diff(id || '', path),
    queryFn: () => gitApi.diff(id!, path),
    enabled: !!id && !!path,
  });
}

export function useGitBind() {
  const queryClient = useQueryClient();
  const setRepoId = useGitStore((s) => s.setRepoId);
  return useMutation({
    mutationFn: ({ path, remotes }: { path: string; remotes?: string }) =>
      gitApi.bind(path, remotes),
    onSuccess: (data) => {
      setRepoId(data.id);
      queryClient.invalidateQueries({ queryKey: gitKeys.repos() });
    },
  });
}

export function useGitAdd() {
  const queryClient = useQueryClient();
  const repoId = useGitStore((s) => s.repoId);
  return useMutation({
    mutationFn: (files: string[]) => gitApi.add(repoId!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(repoId!) });
    },
  });
}

export function useGitReset() {
  const queryClient = useQueryClient();
  const repoId = useGitStore((s) => s.repoId);
  return useMutation({
    mutationFn: (files?: string[]) => gitApi.reset(repoId!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(repoId!) });
    },
  });
}

export function useGitCommit() {
  const queryClient = useQueryClient();
  const repoId = useGitStore((s) => s.repoId);
  return useMutation({
    mutationFn: ({ message, author, email }: { message: string; author?: string; email?: string }) =>
      gitApi.commit(repoId!, message, author, email),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(repoId!) });
      queryClient.invalidateQueries({ queryKey: gitKeys.log(repoId!) });
    },
  });
}

export function useGitCheckout() {
  const queryClient = useQueryClient();
  const repoId = useGitStore((s) => s.repoId);
  return useMutation({
    mutationFn: (files: string[]) => gitApi.checkout(repoId!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(repoId!) });
    },
  });
}

export function useGitUndoCommit() {
  const queryClient = useQueryClient();
  const repoId = useGitStore((s) => s.repoId);
  return useMutation({
    mutationFn: () => gitApi.undoCommit(repoId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(repoId!) });
      queryClient.invalidateQueries({ queryKey: gitKeys.log(repoId!) });
    },
  });
}
