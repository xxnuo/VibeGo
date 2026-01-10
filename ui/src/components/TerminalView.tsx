import React from 'react';
import type { TerminalSession } from '@/types';

interface TerminalViewProps {
  activeTerminalId: string;
  terminals: TerminalSession[];
}

const TerminalView: React.FC<TerminalViewProps> = ({ activeTerminalId, terminals }) => {
  const activeSession = terminals.find(t => t.id === activeTerminalId);

  if (!activeSession) return <div className="p-4 text-ide-mute">No terminal session active</div>;

  return (
    <div className="flex flex-col h-full bg-black text-green-400 font-mono text-sm p-4 overflow-auto">
      {activeSession.history.map((line, idx) => (
        <div key={idx} className="mb-1 break-all">
          <span className="text-blue-400 font-bold">user@mobide:~$</span> {line}
        </div>
      ))}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-blue-400 font-bold">user@mobide:~$</span>
        <div className="w-2 h-4 bg-green-400 animate-pulse" />
      </div>
    </div>
  );
};

export default TerminalView;