# Terminal Backend Implementation - WebTTY 桥接层架构

基于 gotty 的 WebTTY 协议实现终端后端,为前端 xterm.js 提供接口。

## 重大架构升级 (2026-01-08)

**已完成引入 WebTTY 桥接层架构**,实现与 gotty 完全对齐的分层设计。

### 架构对比

**重构前**:
```
Manager → readLoop → broadcast → WebSocket
         ↓
       PTY
```

**重构后**:
```
Manager
  ├─ ActiveTerminal (终端会话)
  │    ├─ PTY (Slave 接口,共享)
  │    └─ WebTTY Pool
  │         ├─ WebTTY #1 (客户端 1)
  │         ├─ WebTTY #2 (客户端 2)
  │         └─ WebTTY #3 (客户端 3)
```

---

## 架构概览

```
internal/service/terminal/
├── session.go          # 数据库模型
├── protocol.go         # 消息协议定义 (已优化)
├── errors.go           # 专用错误类型 (新增)
├── slave.go            # Slave 接口定义 (新增)
├── master.go           # Master 接口 + WSMaster (新增)
├── pty.go              # PTY 实现 Slave 接口
├── webtty.go           # WebTTY 桥接层 (新增,移植自 gotty)
├── options.go          # Options 配置模式 (新增)
└── manager.go          # 终端会话管理器 (重构为 WebTTY 池)

tests/terminal/
├── main.go             # 演示服务器
├── index.html          # xterm.js 前端
└── README.md           # 使用文档
```

---

## 核心组件

### 1. slave 接口 (slave.go)

```go
type slave interface {
    Read(p []byte) (n int, err error)
    Write(p []byte) (n int, err error)
    ResizeTerminal(cols, rows int) error
    WindowTitleVariables() map[string]interface{}
    Close() error
}
```

### 2. master 接口 (master.go)

```go
type master interface {
    Read(p []byte) (n int, err error)
    Write(p []byte) (n int, err error)
}

type wsMaster struct {
    conn *websocket.Conn
    mu   sync.Mutex
}
```

### 3. webTTY 桥接层 (webtty.go)

**核心特性**:
- 独立的 Slave/Master 读写循环
- Base64 编码输出
- 初始化消息 (SetWindowTitle, SetBufferSize)
- 缓冲区大小计算: `maxRawSize = (bufferSize - 1) / 4 * 3`
- onClosed 回调通知 Manager

**关键方法**:
- `Run(ctx)` - 启动主循环
- `slaveReadLoop()` - PTY → WebSocket
- `masterReadLoop()` - WebSocket → PTY
- `sendInitMessage()` - 发送初始化消息

### 4. localCommand (pty.go)

实现 slave 接口:
- `newLocalCommand(shell, args, cwd, cols, rows, opts...)` - 支持 Options
- `WindowTitleVariables()` - 返回 command, pid, cwd
- `ResizeTerminal(cols, rows)` - 调整窗口大小
- `Close()` - 10秒超时关闭

### 5. Manager (manager.go)

**重构为 WebTTY 池管理**:
- 每个客户端独立的 webTTYInstance
- 共享同一个 PTY slave
- 连接数限制 (maxConnections)
- 自动资源清理

**关键方法**:
- `Create(opts CreateOptions)` - 创建终端和 PTY，返回 `*TerminalInfo`
- `Attach(id, conn, opts)` - 创建 webTTY 实例并启动，返回 `*Connection`
- `Close(id)` - 取消所有 webTTY 的 context
- `Get(id)` - 获取 `*TerminalInfo` (不暴露内部类型)
- `Resize(id, cols, rows)` - 调整终端大小
- `Delete(id)` - 删除会话及历史

---

## WebSocket 协议 (已优化)

### 消息类型

```go
// 客户端 → 服务端
MsgInput  = '0'  // 键盘输入 (Base64 编码)
MsgPing   = '2'  // 心跳请求
MsgResize = '4'  // 调整窗口 + JSON

// 服务端 → 客户端
MsgOutput         = '1'  // 终端输出 (Base64 编码)
MsgPong           = '3'  // 心跳响应
MsgSetWindowTitle = '5'  // 窗口标题 + JSON
MsgSetBufferSize  = '6'  // 缓冲区大小 + JSON
```

### 协议流程

1. **客户端连接**: `GET /api/terminals/:id/ws`
2. **服务端发送初始化消息**:
   - SetWindowTitle (`'5' + JSON`): `{"command": "...", "pid": 123, "cwd": "..."}`
   - SetBufferSize (`'6' + JSON`): `32768`
3. **数据传输**:
   - 输出: `'1' + base64(...)`
   - 输入: `'0' + base64(...)`
4. **心跳**: 客户端可发送 `'2'`, 服务端回复 `'3'`
5. **调整窗口**: 客户端发送 `'4' + {"cols": 100, "rows": 30}`

---

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /api/terminals` | GET | 列出所有终端会话 |
| `POST /api/terminals` | POST | 创建新终端 |
| `DELETE /api/terminals/:id` | DELETE | 关闭终端 |
| `GET /api/terminals/:id/ws` | GET | WebSocket 连接 |
| `POST /api/terminals/:id/resize` | POST | 调整终端大小 |

---

## 数据模型

```go
type TerminalSession struct {
    ID          string  // UUID
    Name        string
    Shell       string
    Cwd         string
    Cols        int
    Rows        int
    Status      string  // active, closed
    PTYStatus   string  // running, exited (v2.1 新增)
    ExitCode    int     // 进程退出码 (v2.1 新增)
    HistorySize int64   // 历史缓存大小 (v2.1 新增)
    CreatedAt   int64
    UpdatedAt   int64
}

type TerminalHistory struct {
    ID        int64   // 自增主键
    SessionID string  // 会话 ID
    Sequence  int64   // 序列号
    Data      []byte  // 历史数据
    CreatedAt int64
}
```

---

## 配置选项

### Manager 配置

```go
manager := terminal.NewManager(db, &terminal.ManagerConfig{
    Shell:                "/bin/zsh",
    BufferSize:           32 * 1024,
    MaxConnections:       10,
    HistoryBufferSize:    10 * 1024 * 1024,
    HistoryFlushInterval: 5 * time.Second,
    HistoryMaxAge:        24 * time.Hour,
})
```

### PTY 配置 (内部使用)

```go
pty, err := newLocalCommand(
    shell, args, cwd, cols, rows,
    withCloseTimeout(10*time.Second),
)
```

### WebTTY 配置 (内部使用)

```go
webTTY := newWebTTY(
    master, slave,
    withBufferSize(32*1024),
    withHistoryWriter(writer),
    withOnClosed(func() { /* 清理逻辑 */ }),
    withOnReady(func() { /* 初始化逻辑 */ }),
)
```

---

## 核心特性

### 1. WebTTY 桥接层

- 职责分离: WebTTY 专注协议转换
- 错误隔离: 单个客户端崩溃不影响其他
- 易于测试: WebTTY 可单独测试
- 代码复用: 可用于其他 WebSocket PTY 场景

### 2. 多客户端共享终端

- N:1 架构: 多个 WebTTY 共享一个 PTY
- 并发安全: PTY.Write 有 mutex 保护
- 广播机制: PTY 输出发送到所有 WebTTY

### 3. Base64 编码

- 终端输出自动 Base64 编码
- 支持二进制数据传输
- 缓冲区大小优化

### 4. 初始化消息

- SetWindowTitle: 包含 command, pid, cwd
- SetBufferSize: 告知客户端缓冲区大小

### 5. Options 模式

- WithCloseTimeout: 自定义关闭超时
- WithBufferSize: 自定义缓冲区大小
- WithMaxConnections: 连接数限制

### 6. 持久化

- SQLite 存储会话信息
- 服务重启自动清理孤儿会话
- 支持页面刷新恢复连接

### 7. 历史缓存与状态管理 (v2.1 新增)

**历史缓存机制**:
- 10MB 环形缓冲区 (内存)
- 自动覆盖最旧数据
- WebSocket 重连时自动回放
- 每 5 秒批量持久化到数据库
- 进程退出时强制刷新

**状态分离设计**:
- `session.status`: 会话生命周期 (active/closed)
- `pty_status`: 进程状态 (running/exited)
- 进程退出后会话保持 active,可查看历史或重启
- 手动关闭会话时同时清理进程和历史

**关键特性**:
- 刷新页面不丢失终端内容
- 进程退出不立即清理会话
- 历史数据双重保障 (内存 + 数据库)
- 并发安全的读写锁保护

---

## 测试覆盖

### 单元测试

- **history_buffer_test.go**: 8 个测试 (v2.1 新增)
  - Write/Read 基础操作
  - 环形缓冲区覆盖
  - 大数据写入
  - Reset 重置
  - 并发安全
  - 边界条件

- **webtty_test.go**: 6 个测试
  - 初始化消息
  - Slave → Master 数据流
  - Master → Slave 输入
  - Ping/Pong 心跳
  - Resize 调整窗口
  - onClosed 回调

- **pty_test.go**: 5 个测试
  - WindowTitleVariables
  - Read/Write
  - Resize
  - CloseTimeout
  - 进程退出

- **master_test.go**: 2 个测试
  - Read/Write
  - 并发写入保护

### 集成测试

- **integration_test.go**: 4 个测试
  - CreateAndClose
  - 多客户端共享
  - 连接数限制
  - WebTTY 集成

- **handler/terminal_test.go**: 5 个测试 (v2.1 新增)
  - 创建终端 API
  - 列表终端 API (验证 PTY 状态)
  - 关闭终端 API
  - WebSocket 连接
  - 历史持久化验证

**覆盖率**: **78.1%** ✅

---

## 演示样例

### 运行演示

```bash
cd tests/terminal
go run main.go
```

访问 http://localhost:8080

### 功能演示

- 创建新终端
- 列出所有会话 (显示会话和进程状态)
- 多客户端共享同一终端
- 实时输入输出
- 调整窗口大小
- 关闭终端
- **刷新页面恢复历史内容** (v2.1 新增)
- **查看已退出进程的历史** (v2.1 新增)

详见 `tests/terminal/README.md`

---

## gotty 精华吸收

1. **WebTTY 桥接层**: 完整移植 webtty.go
2. **Master/Slave 接口**: 抽象层设计
3. **Base64 编码**: 输出编码机制
4. **初始化消息**: SetWindowTitle, SetBufferSize
5. **缓冲区计算**: `maxRawSize = (bufferSize - 1) / 4 * 3`
6. **Options 模式**: WithCloseTimeout, WithBufferSize
7. **writeMutex**: 并发写入保护
8. **专用错误**: ErrSlaveClosed, ErrMasterClosed

---

## 依赖

```bash
go get github.com/KennethanCeyer/ptyx
go get github.com/gorilla/websocket
go get github.com/glebarez/sqlite
go get github.com/gin-gonic/gin
go get gorm.io/gorm
```

---

## 参考资源

- **gotty 源码**: `/Volumes/MacData/Users/xxnuo/projects/gotty`
  - `webtty/webtty.go` - WebTTY 桥接层
  - `backend/localcommand/local_command.go` - PTY 实现
  - `server/handlers.go` - WebSocket 处理

- **改进方案**: `/.claude/plans/rippling-jumping-quokka.md`
- **演示文档**: `tests/terminal/README.md`

---

## 版本历史

### v2.3 (2026-01-08) - PTY 广播架构修复

**问题**:
- 刷新页面后连接活动终端，输入第一个字符没有回显
- 原因：多个 WebTTY 实例各自有 `slaveReadLoop` 竞争读取同一个 PTY
- PTY 的 `Read()` 是消耗性的，只有一个 reader 能读到输出

**解决方案**:
- 在 `activeTerminal` 级别添加统一的 `ptyReadLoop`
- PTY 输出由单一 goroutine 读取，广播给所有连接的 master
- WebTTY 添加 `skipSlaveReadLoop` 选项，跳过内部的 slaveReadLoop
- 历史写入也集中在 `ptyReadLoop` 中处理

**改动文件**:
- `manager.go` - 添加 `ptyReadLoop` 广播方法，`activeTerminal` 新增 `bufferSize`/`encoder` 字段
- `webtty.go` - 添加 `skipSlaveReadLoop` 字段，修改 `Run` 方法支持跳过
- `options.go` - 添加 `withSkipSlaveReadLoop` 选项

**架构变化**:
```
重构前 (有竞争):
  WebTTY #1 → slaveReadLoop → PTY.Read() ──┐
  WebTTY #2 → slaveReadLoop → PTY.Read() ──┼→ 竞争同一个 PTY
  WebTTY #3 → slaveReadLoop → PTY.Read() ──┘

重构后 (广播):
  activeTerminal.ptyReadLoop → PTY.Read() → 广播给所有 WebTTY
    ├→ WebTTY #1.Master.Write()
    ├→ WebTTY #2.Master.Write()
    └→ WebTTY #3.Master.Write()
```

### v2.2 (2026-01-08) - API 简化重构

**问题**:
- `Attach` vs `AttachReadOnly` 命名误导，实际区别是"是否 reactivate 已关闭会话"
- Handler 需要 `select {}` 阻塞，不直观
- `Get()` 返回 `*ActiveTerminal`，暴露 PTY、WebTTYs 等内部细节
- 三种 Option 类型 (`ManagerOption`, `WebTTYOption`, `LocalCommandOption`)，命名不一致
- `Create(name, cwd, cols, rows)` 四个位置参数需记住顺序

**新 API 设计**:

```go
type ManagerConfig struct {
    Shell, BufferSize, MaxConnections, HistoryBufferSize int
    HistoryFlushInterval, HistoryMaxAge time.Duration
}

type CreateOptions struct { Name, Cwd string; Cols, Rows int }
type AttachOptions struct { Reactivate bool }
type Connection struct { Done <-chan struct{} }
type TerminalInfo struct { ID, Name, Shell, Cwd, Status, PTYStatus string; ... }

func NewManager(db *gorm.DB, cfg *ManagerConfig) *Manager
func (m *Manager) Create(opts CreateOptions) (*TerminalInfo, error)
func (m *Manager) Get(id string) (*TerminalInfo, bool)
func (m *Manager) Attach(id string, conn *websocket.Conn, opts AttachOptions) (*Connection, error)
func (m *Manager) Resize(id string, cols, rows int) error
```

**改动文件**:
- `types.go` - 新建，定义公开类型
- `manager.go` - 重写，使用新 API
- `options.go` - 简化，移除 ManagerOption，内部 option 小写
- `webtty.go` - `WebTTY` → `webTTY`
- `master.go` - `WSMaster` → `wsMaster`
- `slave.go` - `Slave` → `slave`
- `pty.go` - `LocalCommand` → `localCommand`
- `history_buffer.go` - `HistoryBuffer` → `historyBuffer`
- `errors.go` - 新增 `ErrMaxConnectionsReached`
- `tests/terminal/main.go` - 使用新 API
- `tests/terminal/index.html` - `term.clear()` → `term.reset()` 修复切换终端残留内容
- `handler/terminal.go` - 使用新 API，恢复 Swagger 注释
- `*_test.go` - 更新为小写函数名

**使用示例**:
```go
manager := terminal.NewManager(db, &terminal.ManagerConfig{
    Shell: "/bin/zsh", MaxConnections: 10,
})
info, _ := manager.Create(terminal.CreateOptions{Name: "my-terminal", Cols: 80, Rows: 24})
conn, _ := manager.Attach(info.ID, wsConn, terminal.AttachOptions{Reactivate: true})
<-conn.Done
manager.Resize(info.ID, 100, 30)
manager.Close(info.ID)
```

### v2.1 (2026-01-08) - 历史缓存与状态管理

**核心改进**:
- 历史缓存机制 (10MB 环形缓冲区 + 数据库持久化)
- 状态分离设计 (session.status / pty_status)
- WebSocket 重连历史回放
- 进程退出监听 (不清理会话)
- 批量写入机制 (每 5 秒)

**新增文件**:
- `history_buffer.go` - 环形缓冲区实现
- `history.go` - 数据库持久化逻辑
- `history_buffer_test.go` - 8 个单元测试
- `handler/terminal_test.go` - 5 个集成测试

**修改文件**:
- `session.go` - 添加 PTYStatus, ExitCode, HistorySize 字段
- `manager.go` - 添加监听、回放、持久化逻辑
- `webtty.go` - 添加 historyWriter 字段
- `options.go` - 添加 WithHistoryWriter 选项
- `handler/terminal.go` - 更新 TerminalInfo 结构
- `tests/terminal/index.html` - 显示进程状态徽章

**测试结果**:
- 所有单元测试通过
- 所有集成测试通过
- handler 层测试通过
- 编译成功

### v2.0 (2026-01-08) - WebTTY 架构

- 引入 WebTTY 桥接层
- 优化协议编号 (Input/Output 分离)
- Base64 编码输出
- 初始化消息机制
- Options 配置模式
- 完整测试覆盖 (78.1%)
- xterm.js 演示样例

### v1.0 (初始版本)

- Manager 中心化架构
- 简化协议
- 多客户端共享
- SQLite 持久化
