# VibeGo

A Web IDE built for professionals, designed for Vibe Coding anytime, anywhere. Freely use your Claude Code, Gemini CLI, CodeX, OpenCode, and more.

为专业人士打造，支持随时随地 Vibe Coding 的 Web IDE。 自由使用你的 Claude Code、Gemini CLI、CodeX、OpenCode 及更多工具。

## 技术栈

### 前端

框架：react, react-dom
界面库：shadcn/ui, tailwindcss
图标库：lucide-react
状态管理：Zustand
编辑器组件：monaco-editor
Git diff 组件：codemirror
版本号比较库：compare-versions
列表渲染组件：@tanstack/react-virtual
文件树组件：react-arborist
Markdown 渲染组件：react-markdown
数据存储：Dexie.js
终端渲染库：xterm.js
终端输出流解析：byline, split
缓存：memoize-one, mem, p-memoize, quick-lru

### 后端

框架：Golang, Gin
Git：github.com/go-git/go-git
WebSocket：github.com/gorilla/websocket
定制 PTY 库：github.com/xxnuo/gotty
文件监控：github.com/fsnotify/fsnotify
数据库：SQLite (使用 gorm.io/gorm 和 github.com/glebarez/sqlite 驱动)
