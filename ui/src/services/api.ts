import type { FileNode, GitFileNode, TerminalSession } from '../types';

const API_BASE = '/api';

// --- File System ---

interface BackendFile {
    name: string;
    path: string;
    is_dir: boolean;
    children?: BackendFile[];
    size?: number;
    mod_time?: number;
}

export const getFileTree = async (path: string = '.'): Promise<FileNode[]> => {
    const res = await fetch(`${API_BASE}/file/tree?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error('Failed to fetch file tree');
    const root: BackendFile = await res.json();

    // Transform backend tree to FileNode
    // The backend returns a single root object.
    // We want to return an array of children if we want to show the root contents,
    // OR return the root itself.
    // demo App.tsx expects FileNode[] which are the roots.
    // Let's return [transformedRoot].

    const transform = (node: BackendFile): FileNode => {
        return {
            id: node.path,
            name: node.name,
            type: node.is_dir ? 'folder' : 'file',
            children: node.children ? node.children.map(transform) : undefined,
            // Helper to guess language (simplified)
            language: node.is_dir ? undefined : guessLanguage(node.name)
        };
    };

    return [transform(root)];
};

export const readFile = async (path: string): Promise<string> => {
    const res = await fetch(`${API_BASE}/file/read?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error('Failed to read file');
    const data = await res.json();
    return data.content || '';
};

export const writeFile = async (path: string, content: string): Promise<void> => {
    const res = await fetch(`${API_BASE}/file/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content })
    });
    if (!res.ok) throw new Error('Failed to write file');
};

// --- Git ---

interface GitStatusResponse {
    files: {
        path: string;
        status: string; // "M", "A", "D", "?"
        staged: boolean;
    }[];
}

export const getGitStatus = async (): Promise<GitFileNode[]> => {
    // We assume the backend handles finding the repo (maybe pass ID? or default if only one)
    // The API says `/api/git/list` to get repos.
    // Let's assume we use the first repo found or we need to implement repo selection.
    // For now, let's try to list repos first.
    const listRes = await fetch(`${API_BASE}/git/list`);
    if (!listRes.ok) return []; // No git or error
    const listData = await listRes.json();
    if (!listData.repos || listData.repos.length === 0) return [];

    const repoId = listData.repos[0].id; // Use first repo

    const statusRes = await fetch(`${API_BASE}/git/status?id=${repoId}`);
    if (!statusRes.ok) return [];
    const statusData: GitStatusResponse = await statusRes.json();

    return statusData.files.map((f, idx) => ({
        id: `git-${idx}`,
        name: f.path.split('/').pop() || f.path,
        path: f.path,
        status: mapGitStatus(f.status),
        // we will fetch content on demand or pre-fetch if needed.
        // demo expects original/modified content.
        // real optimization: don't fetch content until clicked.
        // But GitView might expect it.
    }));
};

// Helper: fetch diff content
export const getGitDiff = async (repoId: string, path: string): Promise<{ old: string, new: string }> => {
    const res = await fetch(`${API_BASE}/git/diff?id=${repoId}&path=${encodeURIComponent(path)}`);
    if (!res.ok) return { old: '', new: '' };
    return await res.json();
};

const mapGitStatus = (s: string): 'modified' | 'added' | 'deleted' => {
    if (s.includes('M')) return 'modified';
    if (s.includes('A') || s.includes('?')) return 'added'; // Untracked as added
    if (s.includes('D')) return 'deleted';
    return 'modified';
};

// --- Terminal ---

export const getTerminals = async (): Promise<TerminalSession[]> => {
    const res = await fetch(`${API_BASE}/terminal/list`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.terminals.map((t: any) => ({
        id: t.id,
        name: t.name || 'Terminal',
        history: ['> Session restored.'] // Backend doesn't store history?
    }));
};

export const createTerminal = async (): Promise<TerminalSession> => {
    const res = await fetch(`${API_BASE}/terminal/new`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Terminal' })
    });
    if (!res.ok) throw new Error('Failed to create terminal');
    const data = await res.json();
    return {
        id: data.id,
        name: data.name,
        history: ['> Terminal started.']
    };
};

function guessLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'ts': case 'tsx': return 'typescript';
        case 'js': case 'jsx': return 'javascript';
        case 'json': return 'json';
        case 'html': return 'html';
        case 'css': return 'css';
        case 'md': return 'markdown';
        case 'go': return 'go';
        case 'py': return 'python';
        case 'java': return 'java';
        default: return 'plaintext';
    }
}
