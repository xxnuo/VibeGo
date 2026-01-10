import React, { useState } from 'react';
import type { FileNode } from '@/types';
import { Folder, ChevronRight, ChevronDown, Hash } from 'lucide-react';

interface FileTreeProps {
  nodes: FileNode[];
  onFileClick: (node: FileNode) => void;
  activeFileId?: string;
  depth?: number;
}

const FileTree: React.FC<FileTreeProps> = ({ nodes, onFileClick, activeFileId, depth = 0 }) => {
  return (
    <div className="select-none font-mono text-xs">
      {nodes.map((node) => (
        <FileTreeNode
          key={node.id}
          node={node}
          onFileClick={onFileClick}
          activeFileId={activeFileId}
          depth={depth}
        />
      ))}
    </div>
  );
};

const FileTreeNode: React.FC<{
  node: FileNode;
  onFileClick: (node: FileNode) => void;
  activeFileId?: string;
  depth: number;
}> = ({ node, onFileClick, activeFileId, depth }) => {
  const [isOpen, setIsOpen] = useState(true); // Default open for hacker feel

  const isActive = node.id === activeFileId;
  const paddingLeft = `${depth * 1.5 + 0.5}rem`;

  const handleClick = () => {
    if (node.type === 'folder') {
      setIsOpen(!isOpen);
    } else {
      onFileClick(node);
    }
  };

  return (
    <div>
      <div
        onClick={handleClick}
        className={`flex items-center py-2 pr-2 border-l-2 cursor-pointer hover:bg-ide-accent/10 ${isActive
          ? 'border-ide-accent bg-ide-accent/20 text-ide-accent'
          : 'border-transparent text-ide-mute hover:text-ide-text'
          }`}
        style={{ paddingLeft }}
      >
        <span className="mr-2 opacity-70">
          {node.type === 'folder' ? (
            isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span className="w-3.5 inline-block text-[10px] text-center"></span>
          )}
        </span>

        <span className="mr-2">
          {node.type === 'folder' ? <Folder size={14} /> : <Hash size={14} />}
        </span>

        <span className="truncate">{node.name}</span>
      </div>

      {node.type === 'folder' && isOpen && node.children && (
        <FileTree
          nodes={node.children}
          onFileClick={onFileClick}
          activeFileId={activeFileId}
          depth={depth + 1}
        />
      )}
    </div>
  );
};

export default FileTree;