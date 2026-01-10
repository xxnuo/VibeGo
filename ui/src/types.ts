export const AppView = {
    FILES: 'FILES',
    GIT: 'GIT',
    TERMINAL: 'TERMINAL'
} as const;

export type AppView = (typeof AppView)[keyof typeof AppView];

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
    staged?: boolean;
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
