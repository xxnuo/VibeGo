import React, { useEffect, useCallback } from 'react';
import { useFrameStore } from '@/stores/frameStore';
import TabBar from './TabBar';
import BottomBar from './BottomBar';

interface AppFrameProps {
  children: React.ReactNode;
  onMenuOpen?: () => void;
  onTabAction?: () => void;
  onAddGroup?: () => void;
  onBackToList?: () => void;
}

const AppFrame: React.FC<AppFrameProps> = ({
  children,
  onMenuOpen,
  onTabAction,
  onAddGroup,
  onBackToList,
}) => {
  const initDefaultGroups = useFrameStore((s) => s.initDefaultGroups);

  useEffect(() => {
    initDefaultGroups();
  }, [initDefaultGroups]);

  const handleAddGroup = useCallback(() => {
    onAddGroup?.();
  }, [onAddGroup]);

  return (
    <div className="h-screen flex flex-col bg-ide-bg text-ide-text overflow-hidden font-mono transition-colors duration-300">
      <TabBar onAction={onTabAction} onBackToList={onBackToList} />
      <main className="flex-1 overflow-hidden relative border-b border-ide-border">
        {children}
      </main>
      <BottomBar onMenuClick={onMenuOpen} onAddGroup={handleAddGroup} />
    </div>
  );
};

export default AppFrame;
