import { create } from 'zustand';
import type { FileItem } from './fileManagerStore';

export type PreviewType = 'code' | 'image' | 'video' | 'audio' | 'pdf' | 'markdown' | 'unsupported';

interface PreviewState {
  file: FileItem | null;
  content: string;
  originalContent: string;
  loading: boolean;
  error: string | null;
  editMode: boolean;
  isDirty: boolean;

  setFile: (file: FileItem | null) => void;
  setContent: (content: string) => void;
  setOriginalContent: (content: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setEditMode: (mode: boolean) => void;
  setIsDirty: (dirty: boolean) => void;
  reset: () => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  file: null,
  content: '',
  originalContent: '',
  loading: false,
  error: null,
  editMode: false,
  isDirty: false,

  setFile: (file) => set({ file }),
  setContent: (content) => set({ content }),
  setOriginalContent: (content) => set({ originalContent: content }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setEditMode: (mode) => set({ editMode: mode }),
  setIsDirty: (dirty) => set({ isDirty: dirty }),
  reset: () => set({
    file: null,
    content: '',
    originalContent: '',
    loading: false,
    error: null,
    editMode: false,
    isDirty: false,
  }),
}));

const textMimeTypes = [
  'application/json',
  'application/javascript',
  'application/typescript',
  'application/xml',
  'application/sql',
  'application/x-sh',
  'application/x-python',
  'application/x-ruby',
  'application/x-php',
  'application/yaml',
  'application/toml',
];

export function getPreviewType(mimeType?: string, extension?: string): PreviewType {
  if (!mimeType && !extension) return 'unsupported';

  const ext = extension?.toLowerCase() || '';
  const mime = mimeType?.toLowerCase() || '';

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/markdown') || ext === '.md' || ext === '.mdx') return 'markdown';
  if (mime.startsWith('text/') || textMimeTypes.some(t => mime.includes(t))) return 'code';

  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.go', '.py', '.rs', '.rb', '.php',
    '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt',
    '.json', '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss',
    '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.vue', '.svelte', '.astro', '.lua', '.r', '.m', '.pl', '.ex', '.exs',
    '.hs', '.ml', '.fs', '.clj', '.scala', '.groovy', '.dart', '.zig',
    '.nim', '.cr', '.v', '.d', '.elm', '.erl', '.hrl', '.lisp', '.scm',
    '.txt', '.log', '.ini', '.conf', '.cfg', '.env', '.gitignore',
    '.dockerfile', '.makefile', '.cmake', '.gradle', '.sbt',
  ];

  if (codeExtensions.includes(ext)) return 'code';
  if (ext === '.pdf') return 'pdf';
  if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.ico'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'].includes(ext)) return 'audio';

  return 'unsupported';
}

export function getLanguageFromExtension(extension?: string): string {
  const ext = extension?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.go': 'go',
    '.py': 'python',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.xml': 'xml',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sql': 'sql',
    '.sh': 'shell',
    '.bash': 'shell',
    '.zsh': 'shell',
    '.ps1': 'powershell',
    '.md': 'markdown',
    '.mdx': 'markdown',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.lua': 'lua',
    '.r': 'r',
    '.dart': 'dart',
    '.dockerfile': 'dockerfile',
    '.makefile': 'makefile',
  };
  return langMap[ext] || 'plaintext';
}
