import React from 'react';

interface MobileToolbarProps {
  onInsert: (char: string) => void;
}

const MobileToolbar: React.FC<MobileToolbarProps> = ({ onInsert }) => {
  const chars = ['{', '}', '(', ')', '[', ']', '<', '>', '=', '=>', ';', '"', "'", '`', '$', '!'];

  return (
    <div className="h-10 bg-ide-panel border-t border-ide-border flex items-center overflow-x-auto no-scrollbar px-2 gap-2 shadow-lg z-10">
      {chars.map((char) => (
        <button
          key={char}
          onClick={() => onInsert(char)}
          className="flex-shrink-0 min-w-[32px] h-8 px-2 bg-ide-bg rounded text-sm font-mono text-ide-accent hover:bg-slate-700 active:bg-ide-accent active:text-white transition-colors flex items-center justify-center border border-ide-border"
        >
          {char}
        </button>
      ))}
      <div className="w-2 flex-shrink-0" /> {/* Spacer */}
    </div>
  );
};

export default MobileToolbar;