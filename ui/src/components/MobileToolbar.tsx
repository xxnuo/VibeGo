import React from 'react';

interface MobileToolbarProps {
  onInsert: (char: string) => void;
}

const MobileToolbar: React.FC<MobileToolbarProps> = ({ onInsert }) => {
  const chars = ['{', '}', '(', ')', '[', ']', '<', '>', '=', '=>', ';', '"', "'", '`', '$', '!'];

  return (
    <div className="h-10 bg-black border-t border-ide-accent flex items-center overflow-x-auto no-scrollbar px-1 gap-1 z-10">
      {chars.map((char) => (
        <button
          key={char}
          onClick={() => onInsert(char)}
          className="shrink-0 min-w-[36px] h-8 bg-ide-panel text-ide-accent border border-ide-border hover:bg-ide-accent hover:text-black hover:border-ide-accent active:translate-y-0.5 transition-all flex items-center justify-center font-bold"
        >
          {char}
        </button>
      ))}
      <div className="w-2 shrink-0" />
    </div>
  );
};

export default MobileToolbar;