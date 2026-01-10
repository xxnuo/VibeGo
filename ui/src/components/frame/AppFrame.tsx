import React, { useEffect } from 'react';
import { useFrameStore } from '@/stores/frameStore';
import TopBar from './TopBar';
import BottomBar from './BottomBar';

interface AppFrameProps {
  children: React.ReactNode;
  onMenuOpen?: () => void;
}

const AppFrame: React.FC<AppFrameProps> = ({
  children,
  onMenuOpen,
}) => {
  const initDefaultGroups = useFrameStore((s) => s.initDefaultGroups);

  useEffect(() => {
    initDefaultGroups();
  }, [initDefaultGroups]);

  return (
    <div className="h-screen flex flex-col bg-ide-bg text-ide-text overflow-hidden font-mono transition-colors duration-300">
      <TopBar />
      <main className="flex-1 overflow-hidden relative border-b border-ide-border">
        {children}
      </main>
      <BottomBar onMenuClick={onMenuOpen} />
    </div>
  );
};

export default AppFrame;
