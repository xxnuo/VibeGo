export enum AppView {
  FILES = 'FILES',
  GIT = 'GIT',
  TERMINAL = 'TERMINAL'
}

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  content?: string;
  language?: string;
}

export interface GitFileNode {
  id: string;
  name: string;
  status: 'modified' | 'added' | 'deleted';
  path: string;
  originalContent?: string;
  modifiedContent?: string;
}

export interface TerminalSession {
  id: string;
  name: string;
  history: string[];
}

export interface EditorTab {
  id: string;
  fileId: string;
  title: string;
  isDirty: boolean;
  type: 'code' | 'diff'; 
  data?: any; // For diff content
}

export type Theme = 'light' | 'dark' | 'hacker' | 'terminal';
export type Locale = 'en' | 'zh';