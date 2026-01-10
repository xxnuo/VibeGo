import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fileApi, type SearchOptions } from "@/api/file";

export const fileKeys = {
  all: ["files"] as const,
  tree: (path: string) => [...fileKeys.all, "tree", path] as const,
  list: (path: string) => [...fileKeys.all, "list", path] as const,
  content: (path: string) => [...fileKeys.all, "content", path] as const,
  search: (opts: SearchOptions) => [...fileKeys.all, "search", opts] as const,
};

export function useFileTree(path: string, showHidden = false) {
  return useQuery({
    queryKey: fileKeys.tree(path),
    queryFn: () => fileApi.tree({ path, showHidden }),
  });
}

export function useFileList(path: string) {
  return useQuery({
    queryKey: fileKeys.list(path),
    queryFn: () => fileApi.list(path),
  });
}

export function useFileContent(path: string, enabled = true) {
  return useQuery({
    queryKey: fileKeys.content(path),
    queryFn: () => fileApi.read(path),
    enabled,
  });
}

export function useFileSearch(opts: SearchOptions, enabled = true) {
  return useQuery({
    queryKey: fileKeys.search(opts),
    queryFn: () => fileApi.search(opts),
    enabled,
  });
}

export function useFileSave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      fileApi.write(path, content),
    onSuccess: (_, { path }) => {
      queryClient.invalidateQueries({ queryKey: fileKeys.content(path) });
    },
  });
}

export function useFileCreate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: { path: string; content?: string; isDir?: boolean }) =>
      fileApi.create(opts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fileKeys.all });
    },
  });
}

export function useFileDelete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => fileApi.delete(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fileKeys.all });
    },
  });
}

export function useFileRename() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) =>
      fileApi.rename(oldName, newName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fileKeys.all });
    },
  });
}

export function useFileCopy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      srcPaths,
      dstPath,
      cover = false,
    }: {
      srcPaths: string[];
      dstPath: string;
      cover?: boolean;
    }) => fileApi.copy(srcPaths, dstPath, cover),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fileKeys.all });
    },
  });
}

export function useFileMove() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (opts: {
      oldPaths: string[];
      newPath: string;
      cover?: boolean;
    }) => fileApi.move({ type: "move", ...opts }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: fileKeys.all });
    },
  });
}
