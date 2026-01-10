import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { gitApi } from '@/api/git';
import { useGitStore } from '@/stores';

export const gitKeys = {
  all: ['git'] as const,
  status: (path: string) => [...gitKeys.all, 'status', path] as const,
  log: (path: string) => [...gitKeys.all, 'log', path] as const,
  diff: (path: string, filePath: string) => [...gitKeys.all, 'diff', path, filePath] as const,
};

export function useGitStatus(path: string | null) {
  return useQuery({
    queryKey: gitKeys.status(path || ''),
    queryFn: () => gitApi.status(path!),
    enabled: !!path,
  });
}

export function useGitLog(path: string | null, limit = 20) {
  return useQuery({
    queryKey: gitKeys.log(path || ''),
    queryFn: () => gitApi.log(path!, limit),
    enabled: !!path,
  });
}

export function useGitDiff(path: string | null, filePath: string) {
  return useQuery({
    queryKey: gitKeys.diff(path || '', filePath),
    queryFn: () => gitApi.diff(path!, filePath),
    enabled: !!path && !!filePath,
  });
}

export function useGitAdd() {
  const queryClient = useQueryClient();
  const currentPath = useGitStore((s) => s.currentPath);
  return useMutation({
    mutationFn: (files: string[]) => gitApi.add(currentPath!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(currentPath!) });
    },
  });
}

export function useGitReset() {
  const queryClient = useQueryClient();
  const currentPath = useGitStore((s) => s.currentPath);
  return useMutation({
    mutationFn: (files?: string[]) => gitApi.reset(currentPath!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(currentPath!) });
    },
  });
}

export function useGitCommit() {
  const queryClient = useQueryClient();
  const currentPath = useGitStore((s) => s.currentPath);
  return useMutation({
    mutationFn: ({ message, author, email }: { message: string; author?: string; email?: string }) =>
      gitApi.commit(currentPath!, message, author, email),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(currentPath!) });
      queryClient.invalidateQueries({ queryKey: gitKeys.log(currentPath!) });
    },
  });
}

export function useGitCheckout() {
  const queryClient = useQueryClient();
  const currentPath = useGitStore((s) => s.currentPath);
  return useMutation({
    mutationFn: (files: string[]) => gitApi.checkout(currentPath!, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(currentPath!) });
    },
  });
}

export function useGitUndo() {
  const queryClient = useQueryClient();
  const currentPath = useGitStore((s) => s.currentPath);
  return useMutation({
    mutationFn: () => gitApi.undo(currentPath!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gitKeys.status(currentPath!) });
      queryClient.invalidateQueries({ queryKey: gitKeys.log(currentPath!) });
    },
  });
}
