import { Keyboard as KeyboardIcon, List } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { PluginList, PluginListItem, PluginScaffold, PluginToolbar } from "@/components/common/plugin-kit";
import type { KeyEvent } from "@/components/keyboard";
import { usePluginHost } from "@/framework/host";
import { useTranslation } from "@/lib/i18n";
import type { PageViewProps } from "@/pages/types";
import { applyKeyboardTestInput } from "@/services/keyboard-test-input";

import { useKeyboardStore } from "@/stores/keyboard-store";

interface EventLogEntry {
  id: number;
  event: KeyEvent;
  formatted: string;
}

function formatEvent(e: KeyEvent): string {
  const mods: string[] = [];
  if (e.ctrl) mods.push("Ctrl");
  if (e.alt) mods.push("Alt");
  if (e.shift) mods.push("Shift");
  if (e.meta) mods.push("Meta");
  const modStr = mods.length > 0 ? mods.join("+") + "+" : "";
  if (e.type === "char") {
    const display = e.value === " " ? "Space" : e.value;
    return modStr + display;
  }
  return modStr + e.value;
}

const KeyboardTestView: React.FC<PageViewProps> = () => {
  const host = usePluginHost();
  const locale = host.env.locale as "zh" | "en";
  const t = useTranslation(locale);
  const isMobile = host.env.isMobile;
  const [text, setText] = useState<string>("");
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const nextId = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<string[]>([]);
  const [useNativeKb, setUseNativeKb] = useState(false);
  const [eventLogVisible, setEventLogVisible] = useState(false);

  const scrollBottom = useCallback((ref: React.RefObject<HTMLDivElement | null>) => {
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.scrollTop = ref.current.scrollHeight;
      }
    });
  }, []);

  const handleKeyEvent = useCallback(
    (e: KeyEvent) => {
      const entry: EventLogEntry = {
        id: nextId.current++,
        event: e,
        formatted: formatEvent(e),
      };
      setEventLog((prev) => [...prev.slice(-199), entry]);
      scrollBottom(logRef);

      applyKeyboardTestInput(e, textareaRef, historyRef, setText, setUseNativeKb, host.env.clipboard);
    },
    [scrollBottom, host.env.clipboard]
  );

  const registerHandler = useKeyboardStore((s) => s.registerHandler);

  React.useEffect(() => {
    return registerHandler((e) => {
      if (document.activeElement !== textareaRef.current) return false;
      handleKeyEvent(e);
      return true;
    });
  }, [registerHandler, handleKeyEvent]);

  const handleClear = useCallback(() => {
    setText("");
    setEventLog([]);
  }, []);

  return (
    <PluginScaffold>
      <PluginToolbar className="bg-ide-bg">
        <div className="flex items-center gap-2">
          <KeyboardIcon size={18} className="text-ide-accent" />
          <span className="text-sm font-semibold">{t("plugin.keyboardTest.title")}</span>
        </div>
        <div className="flex items-center gap-2">
          {isMobile && (
            <button
              type="button"
              onClick={() => setEventLogVisible((visible) => !visible)}
              aria-label={t("plugin.keyboardTest.eventLog")}
              aria-controls="keyboard-test-event-log"
              aria-expanded={eventLogVisible}
              title={t("plugin.keyboardTest.eventLog")}
              className={`grid min-h-11 min-w-11 place-items-center rounded-md border border-ide-border ${eventLogVisible ? "bg-ide-panel" : "bg-transparent"}`}
            >
              <List size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={handleClear}
            aria-label={t("plugin.keyboardTest.clear")}
            className="min-h-11 rounded-md border border-ide-border px-3 text-xs"
          >
            {t("plugin.keyboardTest.clear")}
          </button>
        </div>
      </PluginToolbar>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <textarea
          ref={textareaRef}
          name="keyboard-test-input"
          aria-label={t("plugin.keyboardTest.placeholder")}
          value={text}
          onChange={(event) => {
            historyRef.current.push(text);
            if (historyRef.current.length > 100) historyRef.current.shift();
            setText(event.target.value);
          }}
          onBlur={(event) => {
            if (event.target.dataset.ignoreBlur !== "true") setUseNativeKb(false);
          }}
          inputMode={useNativeKb ? "text" : "none"}
          placeholder={t("plugin.keyboardTest.placeholder")}
          className="min-h-0 w-full flex-1 resize-none border-0 bg-ide-panel p-4 pb-[260px] text-base leading-relaxed text-ide-text outline-none shadow-[inset_0_0_10px_rgba(0,0,0,0.05)]"
        />
        {(!isMobile || eventLogVisible) && (
          <PluginList
            ref={logRef}
            id="keyboard-test-event-log"
            className="h-[clamp(112px,34%,168px)] min-h-28 w-full shrink border-t border-ide-border p-2 pb-4 font-mono text-ide-mute md:h-auto md:min-h-0 md:w-[130px] md:shrink-0 md:border-l md:border-t-0 md:pb-[260px]"
          >
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ide-text/60">
              {t("plugin.keyboardTest.eventLog")}
            </div>
            {eventLog.map((entry) => (
              <PluginListItem
                key={entry.id}
                className="mb-1 justify-center gap-2 rounded border-0 bg-ide-panel px-1.5 py-1 break-all whitespace-pre-wrap text-center text-ide-text"
              >
                <span className={entry.event.type === "char" ? "font-normal" : "font-semibold"}>{entry.formatted}</span>
              </PluginListItem>
            ))}
          </PluginList>
        )}
      </div>
    </PluginScaffold>
  );
};

export default KeyboardTestView;
