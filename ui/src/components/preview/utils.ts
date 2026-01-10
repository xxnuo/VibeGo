export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_TEXT_SIZE = 5 * 1024 * 1024;

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function isFileTooLarge(
  size: number,
  type: "text" | "media" = "text",
): boolean {
  return size > (type === "text" ? MAX_TEXT_SIZE : MAX_FILE_SIZE);
}
