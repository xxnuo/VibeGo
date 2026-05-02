import type { GitConflictSegment } from "@/api/git";

export const buildConflictDocuments = (segments: readonly GitConflictSegment[]) => {
  const render = (side: "ours" | "base" | "theirs") =>
    segments
      .map((segment) => {
        if (segment.type === "plain") return segment.text || "";
        return (segment[side] || []).join("\n");
      })
      .join("\n");

  return { ours: render("ours"), base: render("base"), theirs: render("theirs") };
};
