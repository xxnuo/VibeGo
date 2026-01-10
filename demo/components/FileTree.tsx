import React, { useState } from 'react';
import { FileNode } from '../types';
import { Folder, FileCode, ChevronRight, ChevronDown, File } from 'lucide-react';

interface FileTreeProps {
  nodes: FileNode[];
  onFileClick: (node: FileNode) => void;
  activeFileId?: string;
  depth?: number;
}

const FileTree: React.FC<FileTreeProps> = ({ nodes, onFileClick, activeFileId, depth = 0 }) => {
  return (
    <div className="select-none">
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
  const [isOpen, setIsOpen] = useState(false);

  const isActive = node.id === activeFileId;
  const paddingLeft = `${depth * 1.5 + 1}rem`;

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
        className={`flex items-center py-3 pr-4 border-b border-white/5 active:bg-ide-accent/10 transition-colors ${
          isActive ? 'bg-ide-accent/20 text-ide-accent' : 'text-ide-text'
        }`}
        style={{ paddingLeft }}
      >
        <span className="mr-2 text-ide-mute">
          {node.type === 'folder' ? (
            isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />
          ) : (
            <span className="w-4" />
          )}
        </span>
        
        <span className="mr-2 text-ide-accent">
            {node.type === 'folder' ? <Folder size={18} /> : <FileCode size={18} />}
        </span>
        
        <span className="text-sm truncate font-medium">{node.name}</span>
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