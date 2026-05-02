import React, { useMemo, useState } from "react";
import type { GitImageDiff } from "@/api/git";
import type { Locale } from "@/lib/i18n";
import { getTranslation } from "@/lib/i18n";

interface GitImageDiffProps {
  image: GitImageDiff;
  oldSize?: number;
  newSize?: number;
  oldTruncated?: boolean;
  newTruncated?: boolean;
  locale: Locale;
}

type ImageDiffMode = "two-up" | "swipe";

const SAFE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/bmp",
  "image/avif",
]);

export const isSafeImageMimeType = (mimeType: string): boolean => SAFE_IMAGE_MIME_TYPES.has(mimeType);

export const isSafeImageContent = (content: string | undefined): content is string =>
  Boolean(content && /^[A-Za-z0-9+/]*={0,2}$/.test(content) && content.length % 4 === 0);

export const buildGitImageSource = (mimeType: string, content: string | undefined): string | null =>
  isSafeImageMimeType(mimeType) && isSafeImageContent(content) ? `data:${mimeType};base64,${content}` : null;

const formatBytes = (value: number | undefined, locale: Locale) => {
  if (value === undefined || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
};

const GitImageDiffView: React.FC<GitImageDiffProps> = ({
  image,
  oldSize,
  newSize,
  oldTruncated,
  newTruncated,
  locale,
}) => {
  const t = (key: string) => getTranslation(locale, key);
  const [mode, setMode] = useState<ImageDiffMode>("two-up");
  const [swipePercent, setSwipePercent] = useState(50);
  const mimeType = SAFE_IMAGE_MIME_TYPES.has(image.mimeType) ? image.mimeType : "";
  const oldSource = useMemo(() => buildGitImageSource(mimeType, image.old), [image.old, mimeType]);
  const newSource = useMemo(() => buildGitImageSource(mimeType, image.new), [image.new, mimeType]);
  const hasBoth = Boolean(oldSource && newSource);

  if (!oldSource && !newSource) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-ide-mute">
        {t("git.imagePreviewUnavailable")}
      </div>
    );
  }

  const renderImage = (source: string | null, label: string, size: number | undefined, unavailable = false) => {
    if (!source) {
      return (
        <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-xs text-ide-mute">
          <span className="text-ide-text">{label}</span>
          {unavailable && <span>{t("git.imagePreviewUnavailable")}</span>}
        </div>
      );
    }
    return (
      <div className="flex min-h-48 min-w-0 flex-1 flex-col">
        <div className="flex min-h-7 items-center justify-between border-b border-ide-border bg-ide-panel/50 px-2 text-[10px] text-ide-mute">
          <span>{label}</span>
          {size !== undefined && <span className="font-mono">{formatBytes(size, locale)} B</span>}
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-ide-panel p-3">
          <img src={source} alt={label} className="max-h-full max-w-full object-contain" />
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-ide-bg">
      {hasBoth && (
        <div className="flex min-h-8 items-center justify-end gap-1 border-b border-ide-border bg-ide-panel/50 px-2">
          <button
            type="button"
            className={`px-2 py-1 text-[10px] ${mode === "two-up" ? "bg-ide-accent/15 text-ide-text" : "text-ide-mute hover:bg-ide-panel"}`}
            onClick={() => setMode("two-up")}
            aria-pressed={mode === "two-up"}
          >
            {t("git.imageTwoUp")}
          </button>
          <button
            type="button"
            className={`px-2 py-1 text-[10px] ${mode === "swipe" ? "bg-ide-accent/15 text-ide-text" : "text-ide-mute hover:bg-ide-panel"}`}
            onClick={() => setMode("swipe")}
            aria-pressed={mode === "swipe"}
          >
            {t("git.imageSwipe")}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "two-up" || !hasBoth ? (
          <div className="flex min-h-full flex-col gap-px bg-ide-border md:flex-row">
            {(oldSource || oldTruncated) && renderImage(oldSource, t("git.imagePrevious"), oldSize, oldTruncated)}
            {(newSource || newTruncated) && renderImage(newSource, t("git.imageCurrent"), newSize, newTruncated)}
          </div>
        ) : (
          <div className="relative flex min-h-full min-w-[320px] items-stretch justify-center overflow-hidden bg-ide-bg p-3">
            <div className="relative flex min-h-64 w-full max-w-4xl items-center justify-center overflow-hidden bg-ide-panel">
              {newSource && (
                <img
                  src={newSource}
                  alt={t("git.imageCurrent")}
                  className="absolute inset-0 h-full w-full object-contain"
                />
              )}
              {oldSource && (
                <div
                  className="absolute inset-0 overflow-hidden"
                  style={{ clipPath: `inset(0 ${100 - swipePercent}% 0 0)` }}
                >
                  <img src={oldSource} alt={t("git.imagePrevious")} className="h-full w-full object-contain" />
                </div>
              )}
            </div>
            <label className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 bg-ide-panel/90 px-2 py-1 text-[10px] text-ide-mute">
              <span>{t("git.imagePrevious")}</span>
              <input
                type="range"
                min="0"
                max="100"
                value={swipePercent}
                aria-label={t("git.imageSwipe")}
                onChange={(event) => setSwipePercent(event.currentTarget.valueAsNumber)}
              />
              <span>{t("git.imageCurrent")}</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
};

export default GitImageDiffView;
