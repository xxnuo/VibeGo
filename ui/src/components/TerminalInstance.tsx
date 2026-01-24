import React, { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { terminalApi } from "@/api/terminal";

interface TerminalInstanceProps {
  terminalId: string;
  isActive: boolean;
}

const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  terminalId,
  isActive,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const initializedRef = useRef(false);

  const connectWebSocket = useCallback(
    (terminal: Terminal) => {
      if (wsRef.current) {
        wsRef.current.close();
      }

      const wsUrl = terminalApi.wsUrl(terminalId);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        terminal.focus();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "cmd") {
            try {
              // Try to decode base64
              const decoded = atob(msg.data);
              terminal.write(decoded);
            } catch (e) {
              console.warn("Failed to decode base64, writing raw:", e);
              terminal.write(msg.data);
            }
          }
        } catch (e) {
          // Fallback for non-JSON messages
          terminal.write(event.data);
        }
      };

      ws.onclose = () => {
        terminal.write("\r\n[Connection closed]\r\n");
      };

      ws.onerror = () => {
        terminal.write("\r\n[Connection error]\r\n");
      };
    },
    [terminalId],
  );

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;

    initializedRef.current = true;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#1a1a1a",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Backend expects WSMessage protocol
        const msg = {
          type: "cmd",
          data: btoa(data), // Encode to base64
        };
        wsRef.current.send(JSON.stringify(msg));
      }
    });

    connectWebSocket(terminal);

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      initializedRef.current = false;
    };
  }, [terminalId, connectWebSocket]);

  useEffect(() => {
    if (isActive && fitAddonRef.current && terminalRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      }, 50);
    }
  }, [isActive]);

  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current && isActive) {
        fitAddonRef.current.fit();
        // Send resize message to backend
        if (
          wsRef.current?.readyState === WebSocket.OPEN &&
          terminalRef.current
        ) {
          const { cols, rows } = terminalRef.current;
          const msg = {
            type: "resize",
            cols,
            rows,
          };
          wsRef.current.send(JSON.stringify(msg));
        }
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isActive]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ display: isActive ? "block" : "none" }}
    />
  );
};

export default TerminalInstance;
