# Terminal WebSocket Demo

演示 WebTTY 桥接层架构的使用示例。

## 快速开始

### 1. 启动服务器

```bash
cd tests/terminal
go run main.go
```

服务器将在 `http://localhost:8080` 启动。

### 2. 打开浏览器

访问 http://localhost:8080

### 3. 操作流程

1. **创建新终端**: 点击 "创建新终端" 按钮
2. **查看列表**: 自动刷新显示所有终端会话
3. **切换终端**: 从下拉列表选择或点击会话条目
4. **使用终端**: 在 xterm.js 终端中输入命令
5. **关闭终端**: 点击 "关闭当前终端" 按钮

## API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /` | GET | 获取前端页面 |
| `GET /api/terminals` | GET | 列出所有终端会话 |
| `POST /api/terminals` | POST | 创建新终端 |
| `DELETE /api/terminals/:id` | DELETE | 关闭终端 |
| `GET /api/terminals/:id/ws` | GET | WebSocket 连接 |
| `POST /api/terminals/:id/resize` | POST | 调整终端大小 |

## 协议说明

### 消息格式

#### 客户端 → 服务端

```
'0' + base64(data)  = 键盘输入 (MsgInput)
'2'                 = Ping
'4' + JSON          = 调整窗口 (MsgResize)
```

#### 服务端 → 客户端

```
'1' + base64(data)  = 终端输出 (MsgOutput)
'3'                 = Pong
'5' + JSON          = 窗口标题 (MsgSetWindowTitle)
'6' + JSON          = 缓冲区大小 (MsgSetBufferSize)
```

### 初始化流程

1. 客户端创建终端会话 (POST /api/terminals)
2. 客户端建立 WebSocket 连接 (GET /api/terminals/:id/ws)
3. 服务端发送初始化消息:
   - SetWindowTitle (消息 '5'): 包含 command, pid, cwd 等元数据
   - SetBufferSize (消息 '6'): 缓冲区大小
4. 开始接收终端输出 (消息 '1', Base64 编码)

## 核心特性演示

### 1. WebTTY 桥接层

每个客户端连接都有独立的 WebTTY 实例:

```
Manager
  ├─ ActiveTerminal (终端会话)
  │    ├─ PTY (共享的 Shell 进程)
  │    └─ WebTTY Pool
  │         ├─ WebTTY #1 (客户端 1)
  │         ├─ WebTTY #2 (客户端 2)
  │         └─ WebTTY #3 (客户端 3)
```

### 2. 多客户端共享

- 同一终端 ID 可被多个客户端连接
- 所有客户端看到相同的终端输出
- 任何客户端的输入都会广播到所有客户端

### 3. Base64 编码

- 终端输出自动使用 Base64 编码
- 缓冲区大小计算考虑编码扩展: `maxRawSize = (bufferSize - 1) / 4 * 3`

### 4. 错误隔离

- 单个客户端断开不影响其他客户端
- PTY 进程崩溃会通知所有连接的客户端

## 测试场景

### 测试 1: 单客户端

1. 创建终端
2. 输入 `ls -la`
3. 观察输出

### 测试 2: 多客户端共享

1. 在浏览器 A 创建终端
2. 记下终端 ID
3. 在浏览器 B 打开同一页面
4. 从下拉列表选择相同的终端 ID
5. 在 A 中输入命令,观察 B 是否同步显示

### 测试 3: Base64 编码验证

1. 打开浏览器开发者工具 → Network → WS
2. 创建并连接终端
3. 查看 WebSocket 消息
4. 验证输出消息格式: `'1' + base64(...)`

### 测试 4: 初始化消息

1. 打开页面,查看调试日志
2. 创建并连接终端
3. 观察收到的初始化消息:
   - SetWindowTitle (消息 '5')
   - SetBufferSize (消息 '6')

### 测试 5: 错误处理

1. 创建终端
2. 在终端中执行 `exit`
3. 观察 WebSocket 自动断开
4. 检查会话状态更新为 "closed"

## 调试技巧

### 查看 WebSocket 消息

浏览器开发者工具 → Network → WS → 选择连接 → Messages

### 查看协议细节

页面底部的 "协议信息" 和 "调试日志" 显示:
- 连接状态
- 收发消息
- 窗口标题和缓冲区大小

### 后端日志

服务器终端会显示:
- HTTP 请求
- WebSocket 连接/断开
- 错误信息

## 实现细节

### 前端 (index.html)

- **xterm.js**: 终端模拟器
- **FitAddon**: 自适应窗口大小
- **WebSocket**: 二进制消息协议
- **Base64**: 编解码输入输出

### 后端 (main.go)

- **gin**: HTTP 路由
- **gorilla/websocket**: WebSocket 升级
- **terminal.Manager**: 会话管理
- **terminal.WebTTY**: 协议桥接层
- **gorm + sqlite**: 数据持久化

## ⚙️ 配置

修改 main.go 中的配置:

```go
manager := terminal.NewManager(
    db,
    os.Getenv("SHELL"),
    terminal.WithMaxConnections(10),        // 最大连接数
    terminal.WithManagerBufferSize(32*1024), // 缓冲区大小
)
```

## 注意事项

1. **协议版本**: 此实现基于 gotty WebTTY 协议,但消息编号已优化
2. **安全性**: 生产环境需添加认证和授权机制
3. **性能**: Base64 编码有 CPU 开销,适合中小规模使用
4. **并发**: 支持多客户端,但共享 PTY 有并发写入保护

## 学习资源

- [xterm.js 文档](https://xtermjs.org/)
- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [gotty 源码](https://github.com/sorenisanerd/gotty)
- [改进方案文档](../../.claude/plans/rippling-jumping-quokka.md)

## 故障排查

### WebSocket 连接失败

- 检查服务器是否正常运行
- 查看浏览器控制台错误
- 确认终端 ID 有效

### 终端无输出

- 检查 WebSocket 消息是否接收
- 验证 Base64 解码是否正确
- 查看后端日志是否有错误

### 多客户端不同步

- 确认连接到相同的终端 ID
- 检查 WebSocket 连接状态
- 刷新页面重新连接

DONE!
