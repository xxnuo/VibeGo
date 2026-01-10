import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { getTerminalWsUrl } from '../services/api';
import type { TerminalSession } from '../types';

interface TerminalViewProps {
  activeTerminalId: string;
  terminals: TerminalSession[];
}

const TerminalView: React.FC<TerminalViewProps> = ({ activeTerminalId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || !activeTerminalId) return;

    // cleanup previous
    if (terminalRef.current) {
        terminalRef.current.dispose();
    }
    if (wsRef.current) {
        wsRef.current.close();
    }

    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
            background: '#09090b', // zinc-950
            foreground: '#d4d4d8', // zinc-300
            cursor: '#22c55e', // green-500
        }
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Connect WebSocket
    const wsUrl = getTerminalWsUrl(activeTerminalId);
    console.log(`Connecting to terminal WS: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
        term.write('\r\n\x1b[32mTarget Connected.\x1b[0m\r\n');
        // Initial resize
        fitAddon.fit();
    };

    ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            term.write(event.data);
        } else {
             // Blob?
            const reader = new FileReader();
            reader.onload = () => {
                term.write(reader.result as string);
            };
            reader.readAsText(event.data);
        }
    };

    ws.onclose = () => {
        term.write('\r\n\x1b[31mConnection Closed.\x1b[0m\r\n');
    };

    ws.onerror = (e) => {
        console.error("WS Error", e);
        term.write('\r\n\x1b[31mConnection Error.\x1b[0m\r\n');
    };

    term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });
    
    // Handle Window Resize
    const handleResize = () => {
        fitAddon.fit();
        // TODO: Send resize to backend if supported
        // ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    window.addEventListener('resize', handleResize);
    // Also resize on mount slightly delayed to ensure layout
    setTimeout(() => fitAddon.fit(), 100);

    return () => {
        window.removeEventListener('resize', handleResize);
        term.dispose();
        if (ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
    };

  }, [activeTerminalId]);

  return (
    <div className="h-full w-full bg-zinc-950 p-1 overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
    </div>
  );
};

export default TerminalView;
