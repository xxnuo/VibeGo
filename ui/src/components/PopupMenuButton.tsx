import React, { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';

export interface PopupMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'destructive';
}

export interface PopupMenuSection {
  title?: string;
  items: PopupMenuItem[];
}

interface PopupMenuButtonProps {
  trigger: React.ReactNode;
  sections: PopupMenuSection[];
  title?: string;
  className?: string;
  position?: 'top' | 'bottom';
  align?: 'left' | 'right' | 'center';
}

const PopupMenuButton: React.FC<PopupMenuButtonProps> = ({
  trigger,
  sections,
  title,
  className = '',
  position = 'top',
  align = 'center',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleItemClick = (item: PopupMenuItem) => {
    item.onClick();
    setIsOpen(false);
  };

  const positionClasses = position === 'top' ? 'bottom-full mb-2' : 'top-full mt-2';
  const alignClasses = align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2';

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <div onClick={() => setIsOpen(!isOpen)}>
        {trigger}
      </div>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className={`absolute ${positionClasses} ${alignClasses} z-50 bg-ide-panel border border-ide-border rounded-lg shadow-lg overflow-hidden min-w-[200px]`}>
            {title && (
              <div className="flex items-center justify-between px-3 py-2 border-b border-ide-border">
                <span className="text-xs font-bold text-ide-mute uppercase">{title}</span>
                <button onClick={() => setIsOpen(false)} className="text-ide-mute hover:text-ide-text">
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="py-1">
              {sections.map((section, sectionIndex) => (
                <React.Fragment key={sectionIndex}>
                  {sectionIndex > 0 && <div className="h-px bg-ide-border my-1" />}
                  {section.title && (
                    <div className="px-3 py-1">
                      <span className="text-[10px] font-bold text-ide-mute uppercase">{section.title}</span>
                    </div>
                  )}
                  {section.items.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => handleItemClick(item)}
                      className={`w-full px-3 py-2 flex items-center gap-3 hover:bg-ide-bg transition-colors text-left ${
                        item.variant === 'destructive' ? 'text-red-500' : ''
                      }`}
                    >
                      {item.icon && <span className="text-ide-accent">{item.icon}</span>}
                      <span className="text-sm">{item.label}</span>
                    </button>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default PopupMenuButton;
