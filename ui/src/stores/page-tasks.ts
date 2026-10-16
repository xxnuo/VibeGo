import type { PageGroup } from "./frame-store";

export const legacyPageTaskId = (groupId: string, pageId: string) => `page:${groupId}:${pageId}`;

// Retain file IDs and all tab data. A legacy standalone page keeps its owner ID.
export function splitPageTasks(groups: PageGroup[]): PageGroup[] {
  return groups.flatMap((group): PageGroup[] => {
    if (group.type !== "group") return [group];
    const files = group.pages.find((page) => page.type === "files");
    return group.pages.map((page): PageGroup => {
      if (page.type === "files") return { ...group, pages: [page], activePageId: page.id };
      const id = !files && group.pages.length === 1 ? group.id : legacyPageTaskId(group.id, page.id);
      const path = page.path || files?.path;
      return {
        type: "tool",
        id,
        pageId: page.type,
        name: page.label || group.name,
        tabs: page.tabs || [],
        activeTabId: page.activeTabId,
        data: {
          ...group.data,
          path,
          sourceGroupId: group.id,
          sourcePageId: page.id,
          ...(page.type === "terminal" ? { cwd: path } : {}),
          ...(page.type === "git" ? { repoPath: path } : {}),
          ...(files ? { associatedFolderId: group.id } : {}),
        },
      };
    });
  });
}
