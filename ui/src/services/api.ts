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

    const transform = (node: BackendFile): FileNode => {
        return {
            id: node.path,
            name: node.name,
            type: node.is_dir ? 'folder' : 'file',
            children: node.children ? node.children.map(transform) : undefined,
            language: node.is_dir ? undefined : guessLanguage(node.name)
        };
    };

    // Return as array of roots
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

let cachedRepoId: string | null = null;

const getRepoId = async (): Promise<string | null> => {
    if (cachedRepoId) return cachedRepoId;
    try {
        const res = await fetch(`${API_BASE}/git/list`);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.repos && data.repos.length > 0) {
            cachedRepoId = data.repos[0].id;
            return cachedRepoId;
        }
    } catch (e) {
        console.error("Failed to list repos", e);
    }
    return null;
}

export const getGitStatus = async (): Promise<GitFileNode[]> => {
    const repoId = await getRepoId();
    if (!repoId) return [];

    const statusRes = await fetch(`${API_BASE}/git/status?id=${repoId}`);
    if (!statusRes.ok) return [];
    const statusData: GitStatusResponse = await statusRes.json();

    return statusData.files.map((f, idx) => ({
        id: `git-${idx}`,
        name: f.path.split('/').pop() || f.path,
        path: f.path,
        status: mapGitStatus(f.status),
        staged: f.staged
    }));
};

export const getGitDiff = async (path: string): Promise<{ old: string, new: string }> => {
    const repoId = await getRepoId();
    if (!repoId) return { old: '', new: '' };

    const res = await fetch(`${API_BASE}/git/diff?id=${repoId}&path=${encodeURIComponent(path)}`);
    if (!res.ok) return { old: '', new: '' };
    return await res.json();
};

export const stageFile = async (files: string[]): Promise<void> => {
    const repoId = await getRepoId();
    if (!repoId) return;
    await fetch(`${API_BASE}/git/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: repoId, files })
    });
};

export const unstageFile = async (): Promise<void> => {
    const repoId = await getRepoId();
    if (!repoId) return;
    await fetch(`${API_BASE}/git/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: repoId })
    });
};

export const commitChanges = async (message: string): Promise<void> => {
    const repoId = await getRepoId();
    if (!repoId) return;
    await fetch(`${API_BASE}/git/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: repoId, message })
    });
};

const mapGitStatus = (s: string): 'modified' | 'added' | 'deleted' => {
    if (s.includes('M')) return 'modified';
    if (s.includes('A') || s.includes('?')) return 'added';
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
        history: [] // Handled by xterm
    }));
};

export const createTerminal = async (): Promise<TerminalSession> => {
    const res = await fetch(`${API_BASE}/terminal/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Terminal', cols: 80, rows: 24 })
    });
    if (!res.ok) throw new Error('Failed to create terminal');
    const data = await res.json();
    return {
        id: data.id,
        name: data.name || 'Terminal',
        history: []
    };
};

export const closeTerminal = async (id: string): Promise<void> => {
    await fetch(`${API_BASE}/terminal/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
};

export const getTerminalWsUrl = (id: string) => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/terminal/ws/${id}`;
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
