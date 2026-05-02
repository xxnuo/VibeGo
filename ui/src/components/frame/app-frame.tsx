import React, { useEffect } from "react";
import BottomBar from "@/components/frame/bottom-bar";
import SideBar from "@/components/frame/side-bar";
import StatusBar from "@/components/frame/status-bar";
import WorkbenchHeader from "@/components/frame/workbench-header";
import { Keyboard } from "@/components/keyboard";
import { PluginWorkbenchRuntime } from "@/framework/host/workbench-runtime";

interface AppFrameProps {
  children: React.ReactNode;
  onMenuOpen?: () => void;
  onRefresh?: () => void;
  onBackToList?: () => void;
  onNewPage?: () => void;
}

const FOCUSED_CONTROL_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

function revealFocusedControl() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.matches(FOCUSED_CONTROL_SELECTOR)) return;

  const rect = active.getBoundingClientRect();
  const visualViewport = window.visualViewport;
  const viewportTop = visualViewport?.offsetTop ?? 0;
  let viewportBottom = viewportTop + (visualViewport?.height ?? window.innerHeight);
  const footer = document.querySelector("footer");
  if (footer instanceof HTMLElement) {
    const footerRect = footer.getBoundingClientRect();
    if (footerRect.width > 0 && footerRect.height > 0) viewportBottom = Math.min(viewportBottom, footerRect.top);
  }

  const delta =
    rect.bottom > viewportBottom
      ? rect.bottom - viewportBottom + 8
      : rect.top < viewportTop
        ? rect.top - viewportTop - 8
        : 0;
  if (delta === 0) return;

  for (let parent = active.parentElement; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (/(auto|scroll)/u.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
      parent.scrollTop += delta;
      return;
    }
  }
}

const AppFrame: React.FC<AppFrameProps> = ({ children, onMenuOpen, onRefresh, onBackToList, onNewPage }) => {
  useEffect(() => {
    let frame = 0;
    const scheduleReveal = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(revealFocusedControl);
    };
    window.addEventListener("resize", scheduleReveal);
    window.visualViewport?.addEventListener("resize", scheduleReveal);
    window.visualViewport?.addEventListener("scroll", scheduleReveal);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleReveal);
      window.visualViewport?.removeEventListener("resize", scheduleReveal);
      window.visualViewport?.removeEventListener("scroll", scheduleReveal);
    };
  }, []);

  return (
    <div className="h-dvh min-h-dvh flex bg-ide-bg text-ide-text overflow-hidden font-mono transition-colors duration-300">
      <SideBar onMenuClick={onMenuOpen} onNewPage={onNewPage} />
      <div className="flex-1 flex flex-col min-w-0">
        <WorkbenchHeader onRefresh={onRefresh} onBackToList={onBackToList} />
        <main className="flex-1 overflow-hidden relative">
          {children}
          <PluginWorkbenchRuntime />
        </main>
        <StatusBar />
        <Keyboard />
        <BottomBar onMenuClick={onMenuOpen} onNewPage={onNewPage} />
      </div>
    </div>
  );
};

export default AppFrame;
