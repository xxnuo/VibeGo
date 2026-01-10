import React, { useEffect } from 'react';
import { useFrameStore } from '@/stores/frameStore';
import TopBar from './TopBar';
import TabBar from './TabBar';
import BottomBar from './BottomBar';

interface AppFrameProps {
  children: React.ReactNode;
  onMenuOpen?: () => void;
  onTabAction?: () => void;
  onBackToList?: () => void;
}

const AppFrame: React.FC<AppFrameProps> = ({
  children,
  onMenuOpen,
  onTabAction,
  onBackToList,
}) => {
  const initDefaultGroups = useFrameStore((s) => s.initDefaultGroups);
  const topBarConfig = useFrameStore((s) => s.topBarConfig);

  useEffect(() => {
    initDefaultGroups();
  }, [initDefaultGroups]);

  return (
    <div className="h-screen flex flex-col bg-ide-bg text-ide-text overflow-hidden font-mono transition-colors duration-300">
      {topBarConfig.show ? (
        <TopBar />
      ) : (
        <TabBar onAction={onTabAction} onBackToList={onBackToList} />
      )}
      <main className="flex-1 overflow-hidden relative border-b border-ide-border">
        {children}
      </main>
      <BottomBar onMenuClick={onMenuOpen} />
    </div>
  );
};

export default AppFrame;
