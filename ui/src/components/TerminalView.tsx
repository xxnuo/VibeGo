import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { getTerminalWsUrl } from '../services/api';
import type { TerminalSession } from '../types';

interface WSMessage {
    type: 'cmd' | 'resize' | 'heartbeat';
    data?: string;
    cols?: number;
    rows?: number;
    timestamp?: number;
}

interface TerminalViewProps {
    activeTerminalId: string;
    terminals: TerminalSession[];
}

const TerminalView: React.FC<TerminalViewProps> = ({ activeTerminalId }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const heartbeatRef = useRef<number | null>(null);

    const sendMsg = (ws: WebSocket, msg: WSMessage) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    };

    useEffect(() => {
        if (!containerRef.current || !activeTerminalId) return;

        if (terminalRef.current) {
            terminalRef.current.dispose();
        }
        if (wsRef.current) {
            wsRef.current.close();
        }
        if (heartbeatRef.current) {
            clearInterval(heartbeatRef.current);
        }

        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: {
                background: '#09090b',
                foreground: '#d4d4d8',
                cursor: '#22c55e',
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

        const wsUrl = getTerminalWsUrl(activeTerminalId);
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            term.write('\r\n\x1b[32mTarget Connected.\x1b[0m\r\n');
            fitAddon.fit();
            sendMsg(ws, { type: 'resize', cols: term.cols, rows: term.rows });

            heartbeatRef.current = window.setInterval(() => {
                sendMsg(ws, { type: 'heartbeat', timestamp: Date.now() });
            }, 10000);
        };

        ws.onmessage = (event) => {
            try {
                const msg: WSMessage = JSON.parse(event.data);
                if (msg.type === 'cmd' && msg.data) {
                    const decoded = atob(msg.data);
                    term.write(decoded);
                }
            } catch {
                term.write(event.data);
            }
        };

        ws.onclose = (event) => {
            term.write(`\r\n\x1b[31mConnection Closed (Code: ${event.code}).\x1b[0m\r\n`);
            if (heartbeatRef.current) {
                clearInterval(heartbeatRef.current);
            }
        };

        ws.onerror = () => {
            term.write('\r\n\x1b[31mConnection Error.\x1b[0m\r\n');
        };

        term.onData((data: string) => {
            sendMsg(ws, { type: 'cmd', data: btoa(data) });
        });

        const handleResize = () => {
            fitAddon.fit();
            sendMsg(ws, { type: 'resize', cols: term.cols, rows: term.rows });
        };

        window.addEventListener('resize', handleResize);
        setTimeout(() => fitAddon.fit(), 100);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (heartbeatRef.current) {
                clearInterval(heartbeatRef.current);
            }
            term.dispose();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
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
