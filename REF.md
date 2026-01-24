# VibeGo

A Web IDE built for professionals, designed for Vibe Coding anytime, anywhere. Freely use your Claude Code, Gemini CLI, CodeX, OpenCode, and more.

为专业人士打造，支持随时随地 Vibe Coding 的 Web IDE。 自由使用你的 Claude Code、Gemini CLI、CodeX、OpenCode 及更多工具。

## 设计

UI 文件夹内的项目前端设计：

### 框架

- 在一个 IDE 框架中支持显示多种不同页面，并支持页面组的功能
- IDE 框架式的设计主要分为上中下三个部分：
  - 上：左侧按钮主要是页面的 Icon和页面定义的点击功能、中部是页面自定义区域，比如文件管理器页面可以将其作为显示打开的文件的 Tab 页面、右侧按钮是一个功能按钮，比如文件浏览器内可以将其定义为刷新按钮，终端页面内可以将其定义为新建终端 Tab 的按钮；
  - 中部则是页面定义的内容；
  - 底部：左侧是主菜单按钮、中间是类似 Mac 的 Dock 任务栏，可以显示独立页面和页面组的图标，点击切换过去，右侧是一个全屏和取消全屏的按钮。
- 框架存储的数据与会话关联，用于存储会话内打开的页面和页面组等信息。
- 页面组的定义：当前是文件夹页面对应一个页面组，里面有文件浏览器、Git 管理、终端管理三个页面
- 额外的，现在还有任务管理器页面、独立的文件浏览器页面、Git 管理页面、终端管理页面
- 还有特殊页面：欢迎页面（首页）、设置页面
- 主菜单：内部是一个图标按钮的列表，分为两种菜单按钮，一种是内置菜单、一种是页面和页面组定义的操作菜单
- 每个页面的存储数据与会话关联，比如文件管理页面可以存储当前打开的文件夹路径、Git 管理页面可以存储当前打开的 Git 仓库路径，终端页面可以存储当前打开的终端会话等。
- 要能做到切换设备、刷新页面，能快速打开继续之前的工作。

大体框架是这样的，后端的 API 则根据前端的功能按需设计。

### 页面

- 欢迎（首页）：当前代码实现已经完善了
- 设置：当前代码实现差不多完善了
- 文件管理器：当前代码实现差不多完善了
- Git 管理：当前代码实现了一个基础版本
- 终端管理：当前代码不能正常使用
- 任务管理器：当前只是一个占位页面，暂时不用管

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
