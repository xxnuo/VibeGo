import {
  Minus,
  Monitor,
  MonitorOff,
  Play,
  Plus,
  Radius,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { remoteApi } from "@/api/remote";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import { useTranslation } from "@/lib/i18n";
import { registerPage } from "@/pages/registry";
import type { PageViewProps } from "@/pages/types";
import { useAppStore } from "@/stores/app-store";

const POLL_INTERVAL = 3000;

const RemoteControlView: React.FC<PageViewProps> = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);

  const [volume, setVolume] = useState(50);
  const [muted, setMuted] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);

  const volumeSliderRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchState = useCallback(async () => {
    try {
      const v = await remoteApi.getVolume();
      setVolume(v.level);
      setMuted(v.muted);
    } catch {}
  }, []);

  useEffect(() => {
    fetchState();
    pollRef.current = setInterval(fetchState, POLL_INTERVAL);
    return () => clearInterval(pollRef.current);
  }, [fetchState]);

  const doAction = useCallback(
    async (action: string, fn: () => Promise<unknown>) => {
      setLoading(action);
      try {
        await fn();
        await fetchState();
      } catch {}
      setLoading(null);
    },
    [fetchState]
  );

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setVolume(val);
  }, []);

  const handleVolumeCommit = useCallback(
    (val: number) => {
      doAction("volume-set", () => remoteApi.setVolume(val));
    },
    [doAction]
  );

  usePageTopBar(
    {
      show: true,
      centerContent: t("plugin.remoteControl.title"),
    },
    [t]
  );

  return (
    <div className="h-full flex flex-col bg-ide-bg overflow-auto">
      <div className="flex-1 flex flex-col items-center justify-start px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] gap-5 max-w-lg mx-auto w-full">
        <div className="w-full bg-ide-panel rounded-xl border border-ide-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Volume2 size={16} className="text-blue-500" />
              <span className="text-sm font-medium text-ide-text">{t("plugin.remoteControl.volume")}</span>
            </div>
            <span className="text-xs text-ide-mute font-mono tabular-nums">{volume}%</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-ide-bg border border-ide-border hover:bg-ide-border/50 active:scale-95 transition-all"
              onClick={() => doAction("vol-down", () => remoteApi.volumeDown())}
              disabled={loading === "vol-down"}
              aria-label={t("plugin.remoteControl.volumeDown")}
            >
              <Minus size={16} className="text-ide-text" />
            </button>
            <input
              ref={volumeSliderRef}
              type="range"
              id="remote-control-volume"
              name="remote-control-volume"
              min={0}
              max={100}
              value={volume}
              onChange={handleVolumeChange}
              onPointerUp={() => handleVolumeCommit(volume)}
              onKeyUp={() => handleVolumeCommit(volume)}
              aria-label={t("plugin.remoteControl.volume")}
              aria-valuetext={`${volume}%`}
              className="h-11 min-w-0 flex-1 appearance-none bg-transparent cursor-pointer accent-blue-500 slider-volume"
            />
            <button
              type="button"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-ide-bg border border-ide-border hover:bg-ide-border/50 active:scale-95 transition-all"
              onClick={() => doAction("vol-up", () => remoteApi.volumeUp())}
              disabled={loading === "vol-up"}
              aria-label={t("plugin.remoteControl.volumeUp")}
            >
              <Plus size={16} className="text-ide-text" />
            </button>
          </div>

          <div className="flex items-center gap-2 justify-center">
            <button
              type="button"
              className={`flex min-h-11 items-center gap-1.5 px-4 rounded-lg border transition-all active:scale-95 ${
                muted
                  ? "bg-red-500/15 border-red-500/30 text-red-500"
                  : "bg-ide-bg border-ide-border text-ide-text hover:bg-ide-border/50"
              }`}
              onClick={() => doAction("mute", () => remoteApi.volumeMute())}
              disabled={loading === "mute"}
            >
              {muted ? <VolumeX size={16} /> : <Volume1 size={16} />}
              <span className="text-xs font-medium">
                {muted ? t("plugin.remoteControl.unmute") : t("plugin.remoteControl.mute")}
              </span>
            </button>
          </div>
        </div>

        <div className="w-full bg-ide-panel rounded-xl border border-ide-border p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Play size={16} className="text-green-500" />
            <span className="text-sm font-medium text-ide-text">{t("plugin.remoteControl.media")}</span>
          </div>

          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              className="flex h-12 w-12 items-center justify-center rounded-xl bg-ide-bg border border-ide-border hover:bg-ide-border/50 active:scale-90 transition-all"
              onClick={() => doAction("prev", () => remoteApi.mediaPrevious())}
              disabled={loading === "prev"}
              aria-label={t("plugin.remoteControl.previous")}
            >
              <SkipBack size={22} className="text-ide-text" />
            </button>
            <button
              type="button"
              className="flex h-15 w-15 items-center justify-center rounded-2xl bg-green-500/15 border border-green-500/30 hover:bg-green-500/25 active:scale-90 transition-all"
              onClick={() => doAction("play", () => remoteApi.mediaPlayPause())}
              disabled={loading === "play"}
              aria-label={t("plugin.remoteControl.playPause")}
            >
              <Play size={28} className="text-green-500" />
            </button>
            <button
              type="button"
              className="flex h-12 w-12 items-center justify-center rounded-xl bg-ide-bg border border-ide-border hover:bg-ide-border/50 active:scale-90 transition-all"
              onClick={() => doAction("next", () => remoteApi.mediaNext())}
              disabled={loading === "next"}
              aria-label={t("plugin.remoteControl.next")}
            >
              <SkipForward size={22} className="text-ide-text" />
            </button>
          </div>
        </div>

        <div className="w-full bg-ide-panel rounded-xl border border-ide-border p-4 space-y-4">
          <div className="flex items-center gap-2">
            <Monitor size={16} className="text-purple-500" />
            <span className="text-sm font-medium text-ide-text">{t("plugin.remoteControl.screen")}</span>
          </div>

          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              className="min-h-11 flex-1 flex items-center justify-center gap-2 px-2 rounded-xl bg-ide-bg border border-ide-border hover:bg-ide-border/50 active:scale-95 transition-all"
              onClick={() => doAction("screen-off", () => remoteApi.screenOff())}
              disabled={loading === "screen-off"}
            >
              <MonitorOff size={18} className="text-red-400" />
              <span className="text-sm text-ide-text">{t("plugin.remoteControl.screenOff")}</span>
            </button>
            <button
              type="button"
              className="min-h-11 flex-1 flex items-center justify-center gap-2 px-2 rounded-xl bg-ide-bg border border-ide-border hover:bg-ide-border/50 active:scale-95 transition-all"
              onClick={() => doAction("screen-on", () => remoteApi.screenOn())}
              disabled={loading === "screen-on"}
            >
              <Monitor size={18} className="text-green-400" />
              <span className="text-sm text-ide-text">{t("plugin.remoteControl.screenOn")}</span>
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .slider-volume::-webkit-slider-runnable-track {
          background: linear-gradient(to right, #3b82f6 0%, #3b82f6 ${volume}%, var(--ide-border) ${volume}%, var(--ide-border) 100%);
          border-radius: 999px;
          height: 8px;
        }
        .slider-volume::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #3b82f6;
          border: 2px solid white;
          box-shadow: 0 1px 4px rgba(0,0,0,0.3);
          margin-top: -8px;
          cursor: pointer;
        }
        .slider-volume::-moz-range-track {
          height: 8px;
          border-radius: 999px;
          background: var(--ide-border);
        }
        .slider-volume::-moz-range-progress {
          background: #3b82f6;
          border-radius: 999px;
          height: 8px;
        }
        .slider-volume::-moz-range-thumb {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: #3b82f6;
          border: 2px solid white;
          box-shadow: 0 1px 4px rgba(0,0,0,0.3);
          cursor: pointer;
        }
      `}</style>
    </div>
  );
};

registerPage({
  id: "remote-control",
  name: "Remote Control",
  nameKey: "plugin.remoteControl.name",
  descriptionKey: "plugin.remoteControl.description",
  icon: Radius,
  order: 15,
  category: "tool",
  singleton: true,
  View: RemoteControlView,
});

export default RemoteControlView;
