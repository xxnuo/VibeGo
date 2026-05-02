# BlockTerm 桌面端移植台账

本文记录 `thirdparty/waveterm` `main-legacy` 到 VibeGo BlockTerm 的桌面端移植进度。移动端重排、Electron 壳、Wave 分享服务和品牌壳层不纳入本阶段；BlockTerm 可见能力与数据语义仍需逐项移植或明确记录架构等价实现。

## 范围与边界

- 参考版本：`thirdparty/waveterm`，分支 `main-legacy`，基线 `bea1949e47c60703b263e1bcd4633f40ee69db6e`。完整源码工作副本由 `.gitignore` 排除，仓库只跟踪发布所需的 `LICENSE` 和 `NOTICE`；使用 `make verify-waveterm-reference` 校验本地参考树。
- VibeGo 保留现有 Go/Gin + Vite/React 架构和 `/api/terminal` PTY/WebSocket 协议。
- WaveTerm 的 `Session -> Screen -> Line -> Cmd` 概念映射为 VibeGo 的 BlockTerm 工作区、会话和持久化命令块；不直接引入 WaveTerm 的 MobX 全局模型或 Electron IPC。
- 桌面端完成标准是：可操作的持久化 line/block、无损输出、命令生命周期、历史、Renderer、SSH/远程文件和 WaveTerm 对应的桌面效率工作流均有代码与运行证据；移动端布局仍不纳入。
- 复制或改写 WaveTerm 代码时保留原文件的 Apache-2.0 版权声明，并在发布产物中保留对应许可证说明。

## 功能台账

| 功能组 | WaveTerm 能力 | VibeGo 当前状态 | 验收证据 |
| --- | --- | --- | --- |
| 会话 | 多 screen、切换、重连、持久化 | 多个持久 terminal/session 可切换，支持 cursor replay、刷新恢复、工作区 scope 隔离和本地/SSH parent runtime；每个 command block 与 history 持久化自己的 `runtime_type`、`ssh_profile_id` 和 connection context，并可拥有独立 child PTY，浏览器刷新后按精确 `terminal/block/token` route 重绑。启动时 stale session 与 running block 会原子收尾为 `exited`/`interrupted`，服务重启仍不能重附着运行进程 | handler/terminal/SSH/route tests + fresh browser smoke；服务进程外 durable PTY owner 待补 |
| 命令块 | line/cmd 状态、输出、退出码、耗时、并行运行 | 保存命令、原始输出、状态、退出码、时间、cwd、终端几何和有限 before/after shell state；独立 child runtime 支持同一 session 多命令并行、各自 input/resize/signal/close、原地 restart、输出与最终状态持久化，parent close/delete 会收尾全部 child；本地长命令按 best effort 记录前台进程组 leader 为 `cmd_pid`，短命令可能为 `null`，SSH 不伪造本地 PID | block runtime lifecycle/durable/route tests + fresh browser/API smoke；短命令 PID 完整捕获不保证 |
| 块操作 | 重跑、删除、归档/最小化、置顶/书签 | 已实现删除、复制、停止、折叠、置顶、收藏、归档/恢复；命令重跑会清空输出并复用原 block ID/line number，保留展示元数据并启动新的 tokenized lifecycle；running、note 和 OpenAI/model block 不可原地 restart | handler/terminal/Node tests + fresh 浏览器/API smoke |
| 终端渲染 | 默认 terminal renderer、字节 offset 增量重放 | 命令块默认使用 xterm `terminal` renderer，支持切换为 `none`；raw PTY 已由 recorder 按 block 分段持久化并支持 byte cursor 增量恢复与虚拟化重挂载；展示投影仅保留 200000 字符尾部，完整持久化与复制在 16 MiB 硬上限内不截断 | recorder/handler、Node 与当前真实浏览器/API smoke 已通过 |
| 输入 | 多行输入、历史、shell-aware 补全、快捷键 | 支持多行、上下历史、`Ctrl-R` 搜索、`Ctrl-C/U/W/Y/P/N` 编辑、`Shift/Ctrl-Enter` 换行和展开输入；桌面 session/block 操作与输入编辑、历史、换行和提交均可通过 `blockterm.keybindings` 配置；本地与 SSH 均支持有限的静态及动态补全，后端可用 `block_id + block_created_at` 从 durable block/history 精确恢复 connection/cwd，但当前 composer 尚未发送这组上下文；完整 Fig catalog 仍未完成 | Go/Node/browser tests；静态补全、SSH completion、默认桌面快捷键与可配置 keymap UI smoke；composer 精确上下文和完整高级补全待补 |
| 滚动 | 行级虚拟化、锚点、选中行 | 已使用动态高度虚拟化，渲染与导航共用可见顺序；支持方向键、Home/End/PageUp/PageDown、块消失后的邻近选择和 terminal 重挂载 | Node tests（含 1000 行异构动态高度压力）与当前树 2500 块浏览器 smoke 已通过 |
| 渲染器 | terminal、markdown/code/image/csv/pdf/media、Mustache、OpenAI 等插件 | 已接入 `terminal`、`none`、七种文件 Renderer（含 Mustache）和专用 `openai` model source，统一 registry/alias/typed host dispatch；`/chat`、`openai`、`model` 支持可选 `model=` 覆盖，模型输出按 Markdown 流式展示并持久化；七种文件 Renderer 均可切换为 PTY source，文件 source 支持本地/SSH transport | renderer/model/file/raw-output Node tests、blocktermmodel/handler Go tests + 本地 OpenAI-compatible mock provider 浏览器/API smoke；真实外部 provider 未验证 |
| 远程 | SSH profile、认证、known_hosts、远程 PTY/文件 | 已实现 profile CRUD、密码/私钥/agent、host-key 确认、SSH PTY、cwd/resize、独立 SSH channel completion 和 SFTP Renderer/保存；block/history 持久化 per-block local/SSH connection。`/connect` 接受 `local`、profile ID、唯一名称、`user@host` 和 endpoint alias，只改变后续新 block，既有 block 保留原 connection context；运行进程仍不能跨服务重启恢复 | Go tests + 真实 SSH 浏览器/API smoke；服务重附着和 shell 协商待补 |
| Line 模型 | command/text/comment line、renderer 与展示状态 | 已支持 command、note/comment、renderer block，持久化 kind/text/renderer/state/presentation 元数据；command block 已有独立 runtime 与精确 route，child resize 会同步 block/history 的 `term_cols`/`term_rows`，刷新按持久几何恢复，finalizer 兜底写入最后尺寸；仍未拆成独立 line/cmd 两张表 | handler/Node/runtime tests + 当前浏览器 smoke；完整 line/cmd 数据分层待补 |
| Line AI | 当前 line 的 command/output/error、多轮侧栏、代码回填 | 已可从选中的已完成 block 打开 Line AI 侧栏；服务端按可信 `source_block_id` 读取并清理 command/output/error/cwd/status/exit code，多轮 user/assistant 消息有界传递，关闭再打开可恢复当前终端会话，Markdown 代码块可回填命令输入；Line AI block 自动归档且不写命令历史 | config/blocktermmodel/handler、Line AI Node tests + 最新本地 OpenAI-compatible mock provider 浏览器/API smoke；真实外部 provider 与跨页面重载持久化会话未验证 |
| 历史中心 | workspace/remote/收藏筛选、展开 output、多选 purge、跳回上下文 | 已有全局/terminal/workspace/runtime/收藏筛选、分页、持久 output 预览、多选清理、跳回 workspace/screen/line、SSH profile 展示，以及命令 Copy/Use；仍缺具体 SSH profile 和 common command 筛选 | history handler/Node/browser tests；profile/common-command filter 待补 |
| 管理与 Shell 状态 | slash 管理命令、tab/workspace 设置、完整 return state、结构化 prompt | 已实现 `/run`、`/clear`、`/reset`、`/reset:cwd`、`/sync`、`/signal`、`/connect`、主要 `/screen:*`、`/line:*`、`/sidebar:*` 规划与执行，以及 workspace/tab rename/reorder/color/icon；shell state 仍只记录 cwd、shell/integration、最近命令/退出码，不包含完整 env/alias/function return-state 和结构化 prompt | parser/dispatch/session/shell tests；完整 shell-state workflow 待补 |
| 终端效率 | 可点击链接、真实 rows/flexrows、自适应运行高度 | BlockTerm xterm 已接入 `WebLinksAddon`；rows/flexrows 会按物理行测量，运行时只增，完成或 force-full 后可缩，并考虑 DPR 与最大 PTY 尺寸。parent 与多个 child 均按精确 route resize；child xterm 容器尺寸变化会持久化到 block/history，并在刷新和 finalizer 中恢复或收尾 | xterm/terminal-output/runtime tests + geometry 浏览器 smoke |

## 实施记录

### 2026-08-26：基线审计

- 确认 `docs/` 设计约束：桌面工作区铺满、终端工具化、页面不重做外层导航、顶部/任务栏职责分离。
- 确认现有入口为独立 `blockterm` tool page；BlockTerm 通过 `blockterm_blocks` 保存命令块，刷新后从 API 恢复。
- 确认后端已有 `TerminalSession`、PTY ring history、增量 replay、snapshot 和 workspace metadata，可作为移植基础。
- 确认 WaveTerm `main-legacy` 没有名为 BlockTerm 的独立页面，核心能力由 `src/app/line`、`src/models/{screen,cmd,screenlines}` 和 terminal renderer 组成。
- 基线验证：`cd ui && pnpm run build` 通过；`go test ./...` 通过。

### 2026-08-26：桌面端 BlockTerm 实现

- 新增 `BlockTermBlock` 模型、自动迁移和 `/api/blockterm/blocks` 的 list/create/patch/delete 接口。输出以 JSON `[]byte` 的 base64 形式传输，前端负责 UTF-8 编解码。
- BlockTerm 页面支持启动时恢复 block、命令历史、普通文本/TUI 输出、停止/重跑、折叠、置顶、收藏、归档/恢复和删除。
- 每个 block 的 POST/PATCH/DELETE 共用串行 promise 链；输出 patch 使用 250ms debounce。写入最多重试 4 次，最终失败会保留 pending create/patch，并由 drain 向调用方返回失败，不再静默丢失。
- 客户端创建 block 时携带稳定 ID，服务端允许同一 `terminal_id + line_num` 的同 ID POST 幂等重试。
- PTY WebSocket 支持 cursor 查询参数、replay/replay_done、重复输出去重；PTY 在没有 OSC end 帧时将运行中的 block 收尾为 `interrupted`。
- 工作区 scope 切换会使旧恢复请求、WebSocket、重连 timer 和 runtime 失效，并在清空视图前 drain 旧 block 的持久化写入，避免旧响应写入新工作区。
- session 快速切换使用 transition revision、保存 latch 和最新 workspace snapshot；只有当前 workspace 中仍有效的 terminal group 会参与恢复与保存。
- terminal ownership metadata 与 `workspace_state` 先做双向 scope 校验，再在同一数据库事务提交；事务成功后才发布活跃 terminal 的内存 metadata。
- terminal 树删除改为递归清理所有后代的 session、history 和 block；进程启动时遗留的 `running` terminal 会转为 `exited` 只读历史。
- 并发 `Close` 通过 `closeOnce` 合并，`Delete`/`DeleteWorkspace` 会等待 PTY reader、写入 gate 和最终 history flush 后再删除数据库记录。
- BlockTerm POST/PATCH 在读取 JSON 后才进入 lifecycle 临界区，且只在数据库校验和写入期间持锁；响应写出不阻塞 workspace 删除。
- scope 失效后收到的 speculative terminal 创建响应会优先调用 delete 补偿，delete 失败时再 close。

### 2026-08-26：导航与历史正确性

- 提取唯一的可见块排序，归档过滤和置顶顺序由渲染、方向键、Home/End/PageUp/PageDown 共用；PageUp/PageDown 按当前视口内的块数移动。
- 归档、隐藏归档、删除和持久化刷新都会把失效 selection 合法化到原位置的下一块，末尾消失时回退到前一块，并显式执行 focus 与 `scrollIntoView`。
- 块点击遵循 WaveTerm 的文本选择保护；命令与普通文本输出显式允许拖选，鼠标 focus 本身不再改变块 selection。
- `historyDraft` 改为 `string | null`，只在首次进入历史时保存原草稿；空草稿、非空草稿、多次上下移动和持久化刷新均不会再混淆“未保存”与空字符串。

### 2026-08-26：文件 Renderer

- 移植 WaveTerm 风格的 `codeview`、`codeedit`、`markdownview`/`mdview`、`csvview`、`imageview`、`pdfview`、`mediaview` 和 `mustacheview`/`mustache` 命令；Renderer 命令只创建持久化 block，不发送到 shell。`renderer` 与 `state_json` 在服务端限制格式、对象类型和长度。
- code edit 复用 Monaco，支持新建、保存、只读判断和脏状态缓存；Markdown 只解析本地文件内容，本地图片与链接相对 block cwd 解析，外部资源不经文件 API；CSV 使用 Papa Parse 并限制行、列和单元格大小。
- 文件访问统一校验规范路径、符号链接目标和系统黑名单；写入拒绝符号链接、目录、特殊文件和无写位文件。内联下载只允许 PDF、音视频和非 SVG 图片，固定安全 MIME，支持标准 Range，并设置 `nosniff`、`no-referrer` 和私有缓存策略。
- need-key 模式的 Renderer URL 使用启动时随机密钥、随机 nonce 和进程内 view session，不再由访问密钥派生签名。每个浏览器 Cookie 独立，URL 在 10 分钟 idle TTL 内续期并受 24 小时 hard TTL 限制；Range 只滑动服务端 idle deadline，当前浏览器可在 `/api/file/view-session/logout` 撤销。会话有逐访问密钥和全局容量上限，服务重启会使旧 URL/Cookie 失效。
- 前端在到期前、页面恢复可见、pageshow 和网络恢复时串行续期；URL 不变不重挂载，资源错误可用 revision 强制重试；URL 轮换时恢复媒体时间、播放状态、速率、音量和静音状态。

### 2026-08-26：耐久化命令历史

- 新增无外键、无级联删除的 `blockterm_command_history` 快照表；block 创建与 history 写入处于同一数据库事务，启动迁移会幂等回填旧 block，且不覆盖已存在的历史快照。
- 客户端提供 ID 的创建请求会校验 terminal、line、command 和稳定 line/renderer 元数据；可变的 PID、终端几何和 before/after shell state 不参与幂等身份，旧客户端省略这些字段重试仍返回原记录。旧 block 缺 history 时同 ID 重试会补写，删除 block、terminal 或 workspace 后历史仍保留。显式 block 删除会在 history 上留下 tombstone，刷新后的 PTY replay 不会重建已删 block。
- 新增全局及 terminal 级历史查询，默认返回 100 条、最多 200 条，按创建时间和 ID 倒序；搜索中的 `%`、`_` 和反斜杠按字面匹配。
- 普通命令在 block/history 的 POST 成功前不会发送到 PTY；最终持久化失败时保留当前草稿且不发送，POST 成功后若 scope 或 WebSocket 已失效则将 block 标记为 `interrupted`。Renderer 同样先持久化，但从不发送 PTY 输入。
- 上下方向键历史改为从独立 history API 加载，按最近一次出现去重后转换为旧到新顺序；`Ctrl-R` 打开服务端防抖搜索，Enter 只回填草稿，Escape 不修改原草稿，过期请求不能覆盖新结果或刚追加的本地历史。

### 2026-08-27：Line、筛选与停止边界

- 新增 `note/comment` 别名：只创建持久化 note block，不发送 PTY 输入，也不写 command history；Renderer block 同样只持久化、不执行 shell。
- 历史查询增加 `offset`、`has_more` 和 `next_offset`，前端历史面板支持加载更多；`running`/`starred` 筛选状态使用 localStorage 恢复，并在筛选、归档、删除和状态收尾后保持可见 selection。
- 本地 PTY 停止按 `INT -> TERM -> KILL` 升级，但 Linux 只向不同于持久 shell 的前台 job process group 发 TERM/KILL；空闲 shell 或无法可靠定位前台组时返回不支持。SSH 仅通过 PTY 输入发送 `Ctrl-C`，拒绝 TERM/KILL，避免 OpenSSH session signal 杀掉持久 shell。
- Block 输出完整值独立持久化，展示值只保留末尾 200000 字符；raw PTY 由 recorder 按 OSC 边界写入 `blockterm_output_segments`，raw output API 按 cursor 返回分段字节并保留起止 cursor，旧 block 没有 segment 时回退 legacy output；展示缓存仍通过整份快照 PUT 同步。服务端 output API 和客户端缓存单块上限均为 16 MiB，超过上限返回 413。
- 启动迁移先校验既有 BlockTerm 表的主键数据；只有缺少 `kind` 列的旧表才在 `AutoMigrate` 后按原始 `renderer` 分类，已有 `kind` 的表只回填空值，因此切换到文件 Renderer 的 `command` block 在重复迁移后仍保持 `command`。随后补齐非空约束、SQLite 主键保护触发器和缺失的 command history；整个过程在一个事务中幂等执行。Create/Patch JSON body 使用 `MaxBytesReader` 限制为“16 MiB base64 输出 + 2 MiB JSON 开销”（约 24466776 字节），raw output PUT/GET 以 16 MiB 为单块上限。
- 命令 block 新增 `cmd_pid`、`remote_pid`、`term_cols`、`term_rows`、`term_flex_rows`、`term_max_pty_size`、`before_state_json` 和 `after_state_json`。Linux 本地 runtime 暴露受生命周期保护的 process identity API，前端在命令运行窗口轮询并把不同于 shell、且经 `/proc` 验证为 shell 直接 child 的前台进程组 leader 持久化为 `cmd_pid`；短命令、内建命令或不可观测平台保持 `null`。SSH runtime 不调用该 API，也不猜测本地 PID，只保留 OSC 提供的 `remote_pid`。OSC start 当前使用携带 block token、shell PID、cwd 和 command 的 `v3` 帧；只有收到实时 start 帧后才把 `shell_integration` 标记为 true，replay 不覆盖实时 cwd、shell state、last command 或 lifecycle metadata。
- Renderer 命令定义、别名解析、状态校验和 host component dispatch 统一由 registry 驱动；命令块可在 `terminal`、`none` 和七种 Renderer 间切换，七种 Renderer 的切换状态使用 `prompt:source=pty` 读取 raw PTY。PTY 文本 source 复用 code/Markdown/CSV/Mustache 字节上限；image/PDF/media 只为识别出的被动二进制格式创建对象 URL，SVG 和未知字节返回 renderer error，PDF 没有有效 view session 时同样显示 renderer error。未知或损坏的持久化 renderer 继续回退到原始输出。
- 命令 wrapper 在 start frame 前保存完整 `stty -g` 状态，并在命令输出期间关闭 PTY output processing；start frame 后不再插入 framing newline，命令结束后先保存退出码、恢复原 tty 状态，再发送 end frame。这样 raw PTY 中的 LF 和二进制 payload 不再被改写；xterm 仅在显示层启用 `convertEol`，恢复默认 tty 下普通文本的换行语义而不修改持久化字节。
- `presentation.height` 已接入前端动态 virtualizer：恢复时作为估算值，非运行且非折叠 block 测量后回写并保留受支持的 presentation 字段；该值目前不是 renderer 的固定 CSS 高度，实际 DOM 测量仍会覆盖初始估算。`presentation.sidebar` 继续作为兼容元数据；实际布局使用新增的 terminal-scoped BlockTerm view state，侧栏 owner、开关和 `px`/百分比宽度原子校验并持久化，前端实现块移入/移出、关闭后保留 owner、50%/500px 切换、拖动调整和刷新恢复。
- Node virtualizer 压力测试覆盖 1000 个异构动态高度 block，并验证逐行测量、总高度和反向重测；当前树 2500 块浏览器 smoke 进一步验证可见 DOM 有界、Home/End 和 terminal virtualizer 重挂载。

### 2026-08-28：重连握手与生命周期关联

- replay、`replay_done` 后的 state 和实时 output 在 state 握手完成前均按原始顺序复制到有界 FIFO（32 MiB、4096 chunks）；`reset` 只在对应 chunk 实际释放时清理 parser/decoder 边界，握手断线或 FIFO 溢出会回滚到握手起始 cursor 后重连，避免确认但尚未应用的字节丢失或重复。
- state 握手先用服务端 block/token 绑定当前运行块，再释放 replay/live FIFO；FIFO 中存在匹配 start 时保持 `expected` 直到该边界，避免旧 prompt/旧命令字节进入当前 block，没有 start 时则兼容 retained ring 从当前命令中段开始。completion ring 只作为 replay 未包含 end 时的 fallback，握手期间收到的 `pty_exited` 延后到明确 state 后处理。
- Stop 的乐观 `interrupted` 状态收到同 terminal、block 和 token 的 `runtime_signal_failed` NACK 时恢复为 `running` 并保留生命周期绑定；其他匹配的输入拒绝仍按既有语义收尾为 `interrupted`，不匹配的拒绝继续丢弃。
- 命令 wrapper 使用 leading space；Bash 设置 `HISTCONTROL=ignorespace` 并用 `history -d` 清理已记录的 wrapper，zsh 设置 `HIST_IGNORE_SPACE`，以隐藏包含 lifecycle token 的内部命令。token 只用于生命周期关联，不是安全认证边界；共享同一 PTY 的进程仍可观察它。
- POST 已提交但 scope reset 清空 projection 时，detached interruption 只允许携带创建闭包中的 exact token 和 creation fence 回写该 block；删除或 fence 已推进后拒绝旧回写。
- 每个 block 的 fence 在 owner 释放/替换、正常完成、删除和 NACK 恢复等边界推进；旧的异步 interruption/PATCH 不得跨 fence 回写，transition owner 只在有界窗口内作为旧 end/reconcile 的临时证明。
- scope reset 会取消全部 pending output loads；list/output continuation 在 hydrate、output ref 和 DOM 更新前校验 generation 与 request identity，避免旧 scope 输出回灌。

### 2026-08-28：启动运行态收尾

- `Manager.CleanupOnStart` 在单个数据库事务中收集上次进程遗留的 `running` terminal，将其标为 `exited`/只读，并把这些 terminal 所属的 `running` BlockTerm block 标为 `interrupted`、清空退出码并写入结束时间；事务失败时两类记录一起回滚，已完成 block 和非 stale terminal 不受影响。
- 该行为与 WaveTerm `main-legacy` 启动时 `HangupAllRunningCmds` 的历史语义对齐，只修正持久化投影，不代表已恢复 PTY。要在服务重启后继续读写同一 shell/进程，仍需独立于 HTTP 服务生命周期的 durable PTY owner/broker。

### 2026-08-28：静态命令补全与终端重挂载竞态

- 命令输入补充有限的本地静态 spec：`git`、`go`、`pnpm`、`docker` 支持 subcommand、flags、option value、嵌套 subcommand、描述、去重和行尾 ghost suffix；未知命令继续走已有后端动态补全，危险 shell/option-value 上下文不泄露静态候选。完整 Fig catalog 仍未纳入；远程补全已在后续阶段接入。
- terminal mount、raw recovery 和 legacy snapshot hydration 均按实时 session 状态、active owner 与 block status 判定；过期的 render `isActive` 或 stale owner 不再阻断恢复，也不会把旧 snapshot 与 raw GET 同时写入已结束终端。该修正仍不提供跨服务 PTY 重附着。

### 2026-08-28：命令输入编辑快捷键

- 按 WaveTerm `assets/default-keybindings.json` 与 `textareainput.tsx` 补齐 `Ctrl-C` 清空、`Ctrl-U` 剪切光标前内容、`Ctrl-W` 剪切前一个空格分隔词、`Ctrl-Y` 粘贴、`Ctrl-P/N` 历史移动，以及 `Shift/Ctrl-Enter` 在选区插入换行。剪切和粘贴在 Clipboard API 不可用或被拒绝时不让页面抛错。
- 展开输入沿用 WaveTerm `Cmd-E` 的桌面语义；浏览器端同时接受 Meta-E 和 Alt-E，以覆盖 macOS 与 WaveTerm 在 Linux/Windows 上的 portable Cmd 映射。展开状态按 terminal session 隔离，命令发布或 session 关闭后清理。
- 编辑、选区和行数计算拆分为纯函数；定向 Node 回归覆盖快捷键修饰键冲突、光标裁剪、选区替换、多行和 8 行上限。BlockTerm 内部 keymap 与应用级 workspace 导航已在后续阶段补齐。

### 2026-08-28：默认桌面快捷键

- 按 WaveTerm `assets/default-keybindings.json` 接入 portable Cmd 桌面层，浏览器同时接受 Meta 和 Alt：`T/W/1..9/[ ]` 管理 session，`I/L` 聚焦输入或选中 block，`R/Shift-R` 重跑选中或最后命令，`ArrowUp/ArrowDown/PageUp/PageDown` 逐块选择，`D` 删除，`Ctrl-S` 切换 BlockTerm 侧栏，`B/H` 打开 Bookmarks/History。
- 快捷键监听位于单个 `document` 捕获监听器，命中后不会继续触发应用主侧栏的 `Meta-B`；Dialog、AlertDialog、Sheet、Drawer、Dropdown、ContextMenu、Menubar、Popover、Select、Base UI Combobox 和自定义 modal role 打开时都会停用该层。ProjectMenu、NewPageMenu、DirectoryPicker、NewGroupMenu 和 TaskbarItemMenu 已补齐 `dialog`/`aria-modal` 语义。
- 命令输入中的 `Cmd-D` 不删除 block，也不消费按键；块导航仍改变 selection 但保持输入焦点。xterm 允许重跑、删除和块导航；Monaco、文件 Renderer 和普通编辑控件保留 line 级快捷键，包括 Monaco 的 `Cmd-L`。从非编辑目标执行 `Cmd-L` 时，code renderer 会优先聚焦 Monaco textarea。
- 新 session 聚焦命令输入；切换已有 session 或关闭当前 session 后恢复目标 session 最近的 input、xterm、Monaco 或 block 焦点。`Cmd-W` 对 10 个及以上 block 的 session 增加确认；inventory 尚未加载时先等待持久化列表，加载失败或 scope 失效均不关闭。关闭后优先激活右邻、末尾回退左邻，且等待确认期间切换 session 不会被旧闭包覆盖；唯一 session 继续遵循现有 UI 约束不可关闭。
- session 关闭请求按 workspace epoch 和请求身份去重，并在同一 scope 内进入 FIFO；scope reset 会通过 `AbortSignal` 取消旧确认框，旧请求不能清除新请求 latch。全局 DialogProvider 同样按 FIFO 展示 alert/confirm/prompt，支持 queued/active abort、卸载结算和旧回调幂等保护。
- 关闭提交严格按最终 block 持久化、terminal close、前端 cleanup 的顺序执行；即使持久化失败也会尝试 terminal close 以避免遗留后台 PTY，但只有两步都成功才 cleanup。任一步失败时保留 session、output、xterm/ref 和 workspace terminal，仅将 session 标为 `closed` 并提示错误，用户可再次关闭重试，不会因失败路径丢失数据；若网络故障使 close 请求未到达后端，仍需再次关闭重试。
- 普通 Chrome 会在部分平台先截获浏览器保留组合，尤其 macOS 的 `Cmd-T/W/1..9/[ ]/L/D/H`；Meta/Alt 双映射是产品层兼容扩展，不代表所有组合都能在普通浏览器中到达页面。standalone/PWA 或后续桌面壳可以完整接管这些组合。重跑现已清空并复用原 block/line，`Cmd-P` 跨 workspace 搜索和 `Cmd-Ctrl-1..9` workspace 切换也已在后续阶段补齐。

### 2026-08-29：命令原地 restart

- 对照 WaveTerm `wavesrv/pkg/cmdrunner/cmdrunner.go` 的 `LineRestartCommand`、`wavesrv/pkg/sstore/dbops.go` 的 `UpdateCmdForRestart`、`src/models/commandrunner.ts` 的 `lineRestart` 和 `src/app/workspace/workspaceview.tsx` 的 restart keybinding，VibeGo 重跑不再创建新 block，而是复用同一 `terminal_id + block_id + line_num`。
- restart 事务清空 durable output 与 raw segment，重置 PID、退出码、时间、终端几何和 before/after shell state，同时保留 command、renderer、折叠、置顶、收藏、归档和 presentation 等 line 展示元数据。同 token 的未确认请求可幂等重试，不会再次清空已到达的新生命周期输出；不同 token 或其他 active command 返回 busy。
- recorder 以 generation 和 `prepared -> expected -> active` 绑定 restart token，数据库提交前不发布 parser ownership；FIFO barrier、prepared lease、关闭但未 drain 的 recorder guard、runtime write/signal/close 和 stale completion token fence 共同避免旧帧、旧 completion 或 ownership PATCH 覆盖新生命周期。未发送 wrapper 时前端使用 exact token 取消并收敛为 `interrupted`。
- 块按钮与 `Cmd/Alt-R`、`Cmd/Alt-Shift-R` 均调用原地 restart；前端清空同一 xterm/raw cache 后再发送 tagged wrapper，并在 reconnect state 中识别服务端 `prepared` 为本地 `expected`。后续独立 runtime 阶段已允许同一 session 多 block 并行；该能力仍不提供服务重启后的真实 PTY 重附着。
- fresh smoke 发现 restart 曾把秒级 `started_at` 写成 Unix 毫秒，已改为与既有 block API 一致的 Unix 秒并用上下界断言覆盖；同一秒内的极快重跑不要求时间戳严格递增，生命周期身份仍由 token/fence 判定。

### 2026-08-29：独立 command runtime

- 新增独立于 parent terminal 的 per-block runtime owner、route registry、raw output recorder 和 HTTP/WebSocket API。每条 command 使用稳定 `terminal_id + block_id + block_token` 路由，input、resize、signal、close、replay、ack 和最终状态都拒绝模糊 owner 或过期 token。
- 同一 terminal 可并行创建多个 child PTY；本地与 SSH one-shot runtime 都直接执行 block command，TUI 输入不会再误消费追加的 shell `exit`。block runtime 关闭、删除、restart、terminal/workspace 关闭和服务启动 stale cleanup 与 durable block 生命周期串行化。
- 前端将 active child binding 保存到 session storage，刷新后先加载 durable block inventory，再按精确 token 重连；block/history 持久化 per-block `runtime_type`、`ssh_profile_id`、cwd、geometry 和最终状态，不再依赖 parent `activeBlockId`。
- terminal view 持久化 `next_connection`；`/connect local`、profile ID、唯一名称、`user@host` 和 endpoint alias 均只改变后续新建 block，既有 block 不被改写。History 中已展示 SSH profile 并提供 Copy/Use，具体 profile 与 common command 筛选仍未实现。
- child xterm 容器通过 `ResizeObserver` 发送精确 route resize；成功 resize 同步 durable block/history，刷新从持久尺寸恢复，runtime finalizer 兜底写入最后 geometry。completion 后端可用成对的 `block_id + block_created_at` 精确读取 durable block 或未 purge history 的 connection/cwd，当前 composer UI 尚未发送这两个字段。
- 最终 x86-64 ELF SHA-256 为 `a216e5590897a9dfb27268ca066d285b08590e25ee532a435f39349fcbf909fa`。connection smoke 证据位于 `/home/xxnuo/projects/VibeGo/.codex-tmp/blockterm-final-5vMAna/evidence-connection-clean`，geometry smoke 证据位于 `/home/xxnuo/projects/VibeGo/.codex-tmp/blockterm-final-Kxx8NH/evidence-child-geometry-a216e559`；两组结果的 `pageErrors` 与 `badResponses` 均为空。

## 协议契约

- 创建 block：`POST /api/blockterm/blocks`，必须提供 `terminal_id` 和非负 `line_num`；`terminal_id + line_num` 唯一，客户端提供 ID 时支持同 scope 幂等重试。
- 查询 block：`GET /api/blockterm/blocks?terminal_id=<id>`，按 `line_num, created_at, id` 排序，默认只返回元数据；需要完整输出时显式传 `include_output=1`。
- 更新 block：`PATCH /api/blockterm/blocks/:id`；省略字段表示不变，`exit_code`、`started_at`、`finished_at` 可显式传 `null`。
- 原地重跑 block：`POST /api/blockterm/blocks/:id/restart`；请求携带 64 字符 lifecycle token、mode、终端几何和 `before_state_json`。同 token 且参数一致的 prepared/expected/active 请求幂等返回当前 block，不重复清空新输出；不同 token、running/streaming owner、只读或无 runtime terminal 返回冲突或不支持。
- 取消未发送重跑：`POST /api/blockterm/blocks/:id/restart/cancel`；只接受仍处于 `prepared` 的 exact token，并把 block 原子收尾为 `interrupted`。wrapper 已进入 `expected`/`active` 后不能用该接口取消。
- 删除 block：`DELETE /api/blockterm/blocks/:id`；终端删除时由后端一并清理其所有后代 block。
- 查询命令历史：`GET /api/blockterm/history?terminal_id=<id>&q=<text>&limit=<n>&offset=<n>`；`terminal_id` 和 `q` 可省略，响应包含 `has_more`/`next_offset`，history 快照不随 block、terminal 或 workspace 删除。
- 查询补全：`POST /api/blockterm/completion`；`block_id` 与 `block_created_at` 必须成对提供，服务端以 `terminal_id`、block ID 和创建时间校验 durable block 身份，block 已删除时可回退到未 purge 的 history，并拒绝伪造的 runtime/profile/cwd 上下文。当前 composer UI 仍使用 terminal/`next_connection` 上下文，尚未提交这组精确字段。
- 查询 raw PTY 输出：`GET /api/blockterm/blocks/:id/raw-output`，可选 `?cursor=<byte-offset>`；有 segment 时返回 `application/octet-stream`，并设置 `X-BlockTerm-Output-Start-Cursor`、`X-BlockTerm-Output-End-Cursor`、兼容的 `X-BlockTerm-Output-Cursor` 和 `Content-Length`。cursor 落在 segment 间 gap 时从下一 segment 开始，超过保留末端时返回空；没有 segment 的旧 block 回退 legacy output（不返回 segment cursor headers）。
- 查询本地进程身份：`GET /api/terminal/:id/process-identity`；本地 runtime 返回 shell PID/进程组和可观测的前台进程组 leader，SSH 等不支持的 runtime 返回 501，前端不会为其发起轮询。
- 查询或更新视图状态：`GET/PATCH /api/blockterm/sessions/:terminal_id/view`；PATCH 接受受限的 `sidebar` 和可显式清除的 `next_connection`，后者持久化后续 block 使用的 local/SSH、profile 与 logical cwd，不改变 parent PTY 或既有 block。
- 查询或更新模型配置：`GET/PUT/DELETE /api/blockterm/model/config`；配置包含 OpenAI-compatible `base_url`、默认 model、`max_tokens`、timeout 和显式私网开关，响应只返回 `api_token_set`，不会回传 token。模型私有 key 不能经通用 settings API 读取、覆盖或删除。
- 创建模型运行：`POST /api/blockterm/model/runs`；必须绑定处于 running 且非只读的 terminal，可传单轮 `prompt` 或有界 `messages`，Line AI 只提交 `context.source_block_id`，服务端从同 terminal 的持久化 block 解析可信上下文，不接受客户端伪造的 command/output/error 快照。稳定 block ID 以消息、当前命令和可信上下文共同校验幂等身份；运行由模型服务独占 `renderer/status/state_json/output` 生命周期，通用 block API 仅允许折叠、置顶、收藏、归档和 presentation 等展示元数据。
- 订阅或取消模型运行：`GET /api/blockterm/model/runs/:id/events?after=<seq>` 和 `POST /api/blockterm/model/runs/:id/cancel`；events 也接受 `Last-Event-ID`，事件保留不足时返回当前 output snapshot，最终事件携带 `success`/`error`/`interrupted` 状态。
- WebSocket：`GET /api/terminal/ws/:id?cursor=<byte-offset>`；服务端发送带 cursor 的 `replay`，以 `replay_done` 结束，再发送实时 `output`。客户端在 state 握手完成前按原始顺序复制 replay/live 字节到有界 FIFO（32 MiB、4096 chunks）；`reset` 只在实际应用对应 chunk 时重置 parser 边界，握手断线或 FIFO 溢出回滚到握手起始 cursor 重连，state 绑定 block/token 后才释放 FIFO。客户端只在 cursor 过期时接受 reset 快照。
- OSC 633 帧格式为 `ESC ] 633 ; __VIBEGO_BLOCKTERM__ ; start/end ; ... BEL`；cwd 可以包含分号，start 的 command 使用 UTF-8 base64。当前受管 shell integration 使用 `v3` token 帧（start 另含 shell PID），`v2`/legacy 帧仍可识别但不能满足当前 v3 生命周期关联；token 只是生命周期关联值，不是安全认证边界，共享同一 PTY 的进程仍可观察它。shell PID 只标识持久 shell，本地 `cmd_pid` 由 process identity API 获取，SSH 将其记录为 `remote_pid`。

### 2026-08-28：SSH 远程 completion

- 新增 terminal completion capability、runtime provider 和 `/api/blockterm/completion` 的 active SSH 路径；本地 legacy 请求保持 local-only，静态命令 spec 可在动态请求前直接命中。
- SSH completion 通过共享认证连接创建独立 exec session，不写入交互 PTY；外层 login Bash 只用于建立远端用户 PATH，内层 `bash --noprofile --norc` 清除 `BASH_ENV`、`ENV`、`CDPATH` 后运行 `compgen`。每次请求使用随机 begin/end marker，只解析 marker 帧，profile 输出不会污染候选。
- 目录和命令/文件候选在远端分别查询后合并；目录统一保留一个尾部 `/` 并在去重前规范化。候选拒绝 NUL、非法 UTF-8、控制字符和空值；每源查询抓取 `limit+1`，响应最多 100 条并返回 `has_more`。stdout/stderr 分别限制 256 KiB/16 KiB 和 4096/512 行，远端错误不向 HTTP 暴露 stderr 或内部错误文本。
- completion 请求有 5 秒 timeout 和最多 4 个 worker。超时/取消立即返回，但阻塞的 SSH `NewSession`、`Start`、`Wait` 或 `Close` worker 会继续占用原槽位，直到底层调用真实退出；这样保持 worker 数有界并确保迟到 session 被关闭。历史-only terminal 不声明 completion capability，前端在 capability 为 false 时不发起动态请求。
- 定向验证：`go test ./internal/service/sshconnection ./internal/handler ./internal/service/terminal -count=1`、对应 race 测试、`go vet`、`pnpm exec tsc -b --pretty false`、`pnpm exec biome check` 和 `git diff --check` 通过；完整仓库验证与真实 SSH API/浏览器 smoke 待本阶段收尾后补记。

### 2026-08-28：可配置 BlockTerm keymap

- 新增 `blockterm.keybindings` 设置，沿用 WaveTerm command 名称并兼容既有 `blockterm:*` 别名；默认覆盖 session/block 桌面操作，以及输入清空、剪切、粘贴、历史、换行、展开、历史面板和提交。
- keymap 配置限制为 64 KiB、64 个 command 和每项 16 个按键。JSON、结构、command 或按键任一无效时整份回退默认配置；同 scope 冲突只产生诊断，并按固定 command 注册顺序由最后匹配项生效。macOS 浏览器 session fallback 跟随当前裸 `Cmd` 绑定，并纳入逻辑键/物理码冲突诊断。
- 顶栏快捷键对话框按桌面操作与命令输入分组，支持按键录制、逐项删除、恢复默认和冲突提示，不暴露裸 JSON；语法字符自动回退为物理码，第 16 个绑定后明确禁用继续录制。移动端使用独立滚动列表和固定操作栏，录制/删除按钮的可访问名称包含对应命令。保存先写设置 API，成功后才更新前端 store；保存立即生效，刷新后从设置恢复。
- 输入区的 `Ctrl-R` 和 Enter 提交已迁入 keymap action 分发；清空绑定不再回落到旧硬编码逻辑。命令输入 scope 优先于 document capture 的桌面 scope，弹层打开时沿用现有 modal guard 禁用页面快捷键。

### 2026-08-28：应用级 workspace 导航

- `blockterm.keybindings` 新增独立 `app` scope：`Cmd-P` 打开跨 workspace 的 BlockTerm 会话搜索，`Cmd-Ctrl-1..9` 按 `sessionStore.sessions` 当前顺序切换前九个 workspace。应用级 portable `Cmd` 在 macOS 只接受 Meta，在其他平台只接受 Alt，避免 Meta/Alt 同时生效；快捷键设置对话框新增“应用导航”分类。
- 搜索先分页读取完整 Session List，再以 6 个并发请求加载 workspace detail 和 terminal 列表；Session List 使用 `updated_at DESC, id ASC` 稳定分页。当前 workspace 先从本地 store 渐进展示，后台元数据会修正其真实名称；detail 读取使用 `touch=false`，不会因搜索改变 `last_active_at`。
- 搜索范围只包含 `openTools` 中 BlockTerm group 的根 terminal，不包含 split child，也不移植 WaveTerm 的 Connections、History、Settings 等应用入口。远端 terminal 列表成功时以实时名称和存活状态为准，但保持 workspace 中持久化的 terminal 顺序；刷新失败时回退保存的 terminal 并显示部分失败状态。
- 普通查询匹配 workspace 名或 terminal 名；首个 `/` 将查询拆为 workspace/terminal 双字段。排序为当前 workspace 优先，其余保持服务端 workspace 顺序、group 顺序和持久化 terminal 顺序；只有完成全量过滤后才最多展示 100 项，因此第 101 项之后的精确结果仍可命中。
- 跨 workspace 选择统一调用 `sessionStore.switchSession()`，再按真实 BlockTerm group/root terminal 校验并激活。导航 coordinator 使用递增 revision 保证最后请求获胜；目标在切换期间消失、切换失败或用户按 Escape 关闭激活中的搜索框时，会使旧请求失效并尽力切回原 workspace。

### 2026-08-28：OpenAI/model source

- Renderer registry 新增专用 `openai` source，命令入口为 `/chat`、`openai` 和 `model`。未加引号的 `model=<name>` 作为本次运行覆盖，其余 `x=y` 仍是普通 prompt；model 名在前后端统一限制为 256 UTF-8 bytes。原始命令与用户 prompt 分别保存在 block 的 `command`/`text`，不会被 provider-facing prompt 覆盖。
- 模型设置使用独立 `/api/blockterm/model/config` 所有权边界，支持 OpenAI-compatible endpoint、默认 model、`max_tokens`、timeout、token 和显式私网开关。token 只写不回显，canonical key 与历史 alias 统一读取和撤销；通用 settings list/get/set/delete/reset 均不能泄露或篡改模型私有配置。token-only、model 和 timeout 更新不依赖 provider DNS 可用性。
- 公网 endpoint 必须使用 HTTPS；明文 HTTP 仅在显式允许私网后用于 localhost/私有地址。保存 endpoint、请求前连接和每次重定向均重新校验目标，拒绝公网 HTTP、私网绕过、跨 host 重定向和 HTTPS 降级，避免携带 Authorization 的请求被转发到非预期目标。
- provider-facing prompt 对齐 WaveTerm `/chat` engineered prompt：加入当前 shell 类型、运行系统、CLI/shell 专家角色，并在可用时用三反引号附带 terminal 最近命令上下文，同时保留 Markdown 三反引号格式要求；持久化 block 仍保留用户原始 prompt，刷新后不会展示内部扩写文本。
- OpenAI-compatible SSE 必须至少包含一个 completion choices payload 并以 `[DONE]` 正常结束；纯空格和换行 delta 按原样保留，malformed payload、空 choices、提前 EOF、timeout 和非 2xx 均转为去除 token 的持久化 error。增量 output 与对应 event sequence 在同一临界区提交，最终写入先重试再使用相同 ownership predicate 的补偿更新，不能把 durable block 遗留在 `streaming`；error 文本写入 `state_json` 并可在刷新或内存 job 淘汰后恢复。
- 浏览器按 `seq`/`Last-Event-ID` 恢复事件，丢失事件窗口时使用服务端 snapshot 收敛；仍在运行的内存 job 会拒绝超前 cursor，已完成的内存或持久化 run 可接受 `final_seq + 1` 并返回私有 snapshot，其他越界值拒绝且不推进服务端序号。401/403/404/410 等永久 HTTP 错误停止重连，408/425/429、5xx 和网络错误按 250ms 至 4s 退避；只有接受新序号或有效输出才重置退避，`200 + EOF` 不会形成高频循环。最终事件会结束本地 `streaming` 投影并保留 Markdown 输出或持久化错误。
- 创建模型 block 复用每 block 串行重试链和稳定 ID；若 POST 结果无法确认，会在同一队列中依次尝试取消和删除补偿。服务端只允许在 running、非只读 terminal 上登记 job，并让 Create/Cancel 共用 admission gate；terminal close/exit 与模型登记、增量写入和最终写入通过 terminal 级生命周期锁串行化，最终写入会同时复查 live 与 durable 状态，已发布 close 时即使 provider 随后正常 `[DONE]` 也只能收敛为 `interrupted`。显式停止、terminal 关闭、timeout 和服务启动清理会收敛为持久化 `success`/`error`/`interrupted`，删除则先取消再移除记录且拒绝迟到 job 重建。关闭 session 使用 `Promise.allSettled` 取消全部运行中的模型任务，单个取消失败不阻断 PTY 关闭。

### 2026-08-29：Line AI 与终端链接

- 选中已完成 block 后可打开 Line AI 侧栏；会话按 terminal/source scope 隔离，切换终端或 source 不会串线，关闭再打开会恢复当前会话。首轮请求携带所选 block 的可信上下文，后续请求按 user/assistant 完整轮次追加；模型 Markdown 中的 fenced code block 提供回填命令输入操作。
- 前端只发送 `source_block_id`，后端重新读取同 terminal 的 durable block，并拒绝 note、running、streaming、缺失或跨 terminal source。command/output/error/status/cwd 在 UTF-8、ANSI/ECMA-48 控制序列和字节上限处理后，以明确标记为不可信数据的 JSON 注入最后一条 user prompt；OSC 8、CSI、DCS、SOS、PM、APC、C1、CAN/SUB 和未闭合 string control 均有回归覆盖。
- Line AI run 使用预留 line number 创建归档 model block，不写 `blockterm_command_history`；启动迁移与通用 block 写入沿用相同判断。稳定 ID 的 request hash 覆盖多轮 messages 和可信 source snapshot，未确认 POST 继续接回同一 ID，已确认失败后的重试生成新 ID。关闭侧栏会立即中止 SSE，并在创建请求落定后再次取消，避免 POST/cancel 竞态遗留后台请求。
- BlockTerm xterm 与普通终端保持一致，加载 `WebLinksAddon` 识别并打开 HTTP(S) 链接；链接 addon 与 terminal 生命周期一起 dispose，不改变 raw PTY 持久化内容。

## 当前验证边界

- 2026-08-29 最终 x86-64 ELF SHA-256 `a216e5590897a9dfb27268ca066d285b08590e25ee532a435f39349fcbf909fa`。`/home/xxnuo/projects/VibeGo/.codex-tmp/blockterm-final-5vMAna/evidence-connection-clean` 验证 per-block local/SSH connection、`/connect` 多种 profile 引用、只影响后续 block、刷新恢复、History Copy/Use 与 SSH profile 展示；`/home/xxnuo/projects/VibeGo/.codex-tmp/blockterm-final-Kxx8NH/evidence-child-geometry-a216e559` 验证多个 child 的 exact routed resize、block/history 几何持久化、刷新恢复和 finalizer geometry。两组 smoke 的 `pageErrors=[]`、`badResponses=[]`。
- 原地 restart 的纯 UI patch 在 detached worktree 通过 65 个定向 Node tests（64 pass、1 skip）、`pnpm exec tsc -b --pretty false`、`pnpm run check`、`pnpm run build` 和 `git diff --check`；后端 timestamp 修复通过 restart 定向 terminal/handler tests。fresh x86-64 二进制 SHA-256 `eb54b44082c3f92d4464069de9d70cc5c38bf3be9c12666f27025a252e642977` 在 `1440x1000` 下真实执行按钮 restart 和 `Alt-R` restart，两次均保持 block `mtdn78ys-bk4ks3`、line `0` 和单一 block 记录，最新 raw output 为 24 字节；restart 请求为 2、token 均唯一有效，`pageErrors`/`badResponses`/failures 均为空。截图为 `/home/xxnuo/.cache/blockterm-restart-smoke-a0a0cc0.png`，服务端口已清理。
- 当前 Line AI 工作树已通过：`go test ./internal/config ./internal/service/blocktermmodel ./internal/handler -count=1 -timeout 300s`、`go test ./internal/service/terminal -run 'ModelRun|ModelBlock' -count=1 -timeout 300s`、54/54 个 Line AI/renderer/sidebar/virtualizer Node tests、相关文件 Biome、`pnpm exec tsc -b --pretty false`、`pnpm run build` 和 `git diff --check`。
- 最新 fresh Line AI 浏览器/API smoke 使用独立配置、端口 `29943/31944` 和当前 x86-64 ELF SHA-256 `69cc202a43b690792bed23081a52125088252e8a86f70573ccbbe2b0336f5669`，证据目录 `/home/xxnuo/.cache/vibego-line-ai-smoke-final5-ctYsVE`。真实执行 source 命令、两轮 AI、代码回填、关闭再打开、Create 前 Stop/cancel 竞态、归档/恢复 source、AI 后普通命令和 history 查询；provider 请求数为 3，正常多轮消息数为 `1 -> 3`，竞态中首个 cancel 返回预期 404、Create 后二次 cancel 关闭 provider 连接且 block 收敛为 `interrupted`。后续普通命令成功且 `line_num=4`，history 无 `/chat`，恢复归档 source 不会自动重开侧栏。`390x844` 下 `scrollWidth=innerWidth=390`、侧栏 `194px`、输入区 `116px`；`pageErrors`、非预期 HTTP 错误和 failures 均为空。smoke 使用可控本地 OpenAI-compatible provider，不代表真实外部 provider。
- OpenAI/model source 定向验证已通过：后端提交 `9ddeded` 的 `blocktermmodel`、handler、terminal lifecycle 普通/race/vet/build 验证通过；terminal 生命周期确定性覆盖 provider 已持久化 partial、terminal live 状态已 closed 但 durable row 仍 running、provider 随后 `[DONE]` 的交错，最终 block/event 必须为 `interrupted`、保留 partial 且 `exit_code=null`。前端提交 `7ad5fb4` 在隔离 worktree 通过 `pnpm exec tsc -b --pretty false`、相关 Biome 检查、`node --test --test-concurrency=1 tests/blockterm-renderer.test.mjs tests/blockterm-persistence.test.mjs`（40/40）、`pnpm run build` 和 `git diff --check`。
- 竞态修复后的一个共享工作树快照曾通过：`go test ./... -count=1 -timeout 300s`、`go test ./... -race -p 1 -count=1 -timeout 300s`、`go vet ./...`、`go build ./...`、`cd ui && pnpm run check`、`pnpm exec tsc -b --pretty false`、`pnpm run build` 和 `node --test --test-concurrency=1 tests/*.test.mjs`（313 tests：312 pass、1 skip、0 fail）。该结果早于后续并行 Codex、Git 和响应式 UI 改动，不能作为当前脏工作树的全量通过声明。
- model API/Playwright 历史 smoke 证据目录 `/home/xxnuo/.cache/vibego-blockterm-smoke/20260829-model-race-final-001900`，使用端口 `24973/31973`，x86-64 ELF SHA-256 `e910601deb3c73f1dc796992c87865b15bcbce549a90a181af7f9defb10f14bb`。smoke 使用可控的本地 OpenAI-compatible mock provider，不代表真实外部 provider；验证 token 不回显、稳定 ID 幂等、engineered prompt、非法 cursor、closed terminal admission、流式 Markdown 与刷新恢复、永久 events HTTP 错误收敛，以及 active run 已持久化 `partial` 后关闭 terminal 的最终 block/SSE event 均稳定为 `interrupted`、保留 partial、`exit_code=null`。`consoleErrors`、`pageErrors`、非预期 `requestFailures`、`badResponses` 和 stderr 均为空，端口与进程已清理。当前源码和 `ui/dist` 已晚于该 ELF，且 smoke 脚本位于缓存目录而非仓库，因此它只证明当时构建快照，不是当前树 fresh smoke。
- 应用级 workspace 导航当前共享工作树验证通过：`cd ui && pnpm run check`（Biome 214 files）、`pnpm exec tsc -b --pretty false`、`node --test --test-concurrency=1 tests/*.test.mjs`（299 tests：298 pass、1 skip、0 fail）、`pnpm run build`、`GOTOOLCHAIN=go1.26.1+auto GOTMPDIR=/home/xxnuo/.cache/g go test ./... -count=1 -timeout 300s`、`git diff --check` 和目标 Go 文件 `gofmt -d` 均通过。
- 最新应用级 workspace 导航 fresh smoke 证据目录 `/home/xxnuo/.cache/vibego-completion-20260828-193100-dcSlii`，实际 x86-64 ELF SHA-256 `e0ec62083816bb37c0e7005be49bb7494cfdce2525b55de0659aff56a845d5c5`。真实验证 `Cmd-P`、workspace/terminal 与首个 `/` 双字段过滤、第 101 项之后精确命中、持久 terminal 顺序、split child 排除、部分失败保存值回退、跨 workspace terminal 激活、快速切换最后请求获胜、Escape 原 workspace 补偿，以及桌面和 `390x844` 无横向溢出；`consoleErrors`、`pageErrors`、非预期 `requestFailures` 和 `badResponses` 均为空，服务/CDP 端口已清理。

- keymap 批次在基线 `fa61220` 的隔离 worktree 完成验证：`pnpm run check`（Biome 199 files）、`pnpm exec tsc -b --pretty false`、`node --test --test-concurrency=1 tests/*.test.mjs`（274 tests：273 pass、1 skip、0 fail）、`pnpm run build`、`go test ./... -count=1 -timeout 300s` 和 `git diff --check` 均通过。Go 使用 `GOTOOLCHAIN=go1.26.1+auto` 与短路径 `GOTMPDIR=/home/xxnuo/.cache/g`；更长的临时路径会使 SSH agent Unix socket 测试因路径长度失败。
- 最新 keymap fresh smoke 使用 `https://127.0.0.1:24691`，证据目录 `/home/xxnuo/.cache/vibego-keymap-evidence-stable-SAI2YV`，实际 x86-64 ELF SHA-256 `938f8ef5ed45431b287140b46714cdd84993370d967ba43e7f6e03d6f602985e`。验证改键与删除、特殊符号物理码录制、16 键上限、可访问名称、立即生效、刷新保留、保存失败不更新持久值或 effective keymap、恢复默认、modal guard，以及桌面和 `390x844` 移动布局；移动端列表独立滚动、头部和底栏固定且无横向溢出。`pageErrors=[]`；3 次既有 `workspaceCurrentSessionId` 404、1 次主动注入的 settings 500 及对应请求中止均为预期噪声。
- 此前 keymap 阶段的共享工作树验证通过：`cd ui && pnpm run check`（Biome 200 files）、`pnpm exec tsc -b --pretty false`、`node --test --test-concurrency=1 tests/*.test.mjs`（254 tests：253 pass、1 skip、0 fail）、`pnpm run build`、`go test ./... -count=1 -timeout 300s`、`go test ./... -race -p 1 -count=1 -timeout 300s`、`go vet ./...`、`go build ./...` 和 `git diff --check`。Go 命令使用 `/home/xxnuo` 下的短路径 `TMPDIR/GOTMPDIR/GOCACHE`，避免已满的 `/tmp` 影响结果；本阶段最新全量计数以上述 313 tests 为准。
- 为排除共享工作树中未提交 Git UI 变更的影响，本次暂存 patch 另行应用到 HEAD detached worktree：`pnpm run check`（Biome 197 files）、`pnpm exec tsc -b --pretty false`、`node --test --test-concurrency=1 tests/*.test.mjs`（252 tests：251 pass、1 skip、0 fail）和 `pnpm run build` 均通过。
- 最新默认桌面快捷键 fresh smoke 使用端口 `24478/30428`，证据目录 `/home/xxnuo/vibego-smoke-runs/vibego-final-blockterm-20260828-131410-rRBeIU`，实际 x86-64 ELF SHA-256 `a05bed6e16de88c97e0fcc0d5eba86d81fd6967d47aa653a04b803bfaa38afe8`，`SMOKE_STATUS=passed`。除桌面快捷键、modal/editing 保护、session 导航与焦点恢复外，还验证 `crossSessionCloseQueue=true`、scope 切换通过 `AbortSignal` 关闭旧确认框，以及持久化失败保留数据后可重试关闭（`retryAttempts=6`）。脚本主动注入的 6 次 HTTP 500 与 6 条 Chrome console error 逐次匹配预期；非预期 `requestFailures`、`badResponses`、`consoleErrors`、`pageErrors` 均为空，smoke stderr 为空，端口和进程已清理。测试 hook 构建已由默认 `pnpm run build` 覆盖，默认 `ui/dist` 不含 hook 标识，临时脚本未纳入仓库。
- 最新 fresh-reload 浏览器/API smoke 使用 `VITE_BLOCKTERM_TERMINAL_TEST_HOOK=1 TMPDIR=/home/xxnuo/vibego-build-tmp GOTMPDIR=/home/xxnuo/vibego-build-tmp VIBEGO_RUN_BASE=/home/xxnuo/vibego-smoke-runs VIBEGO_SMOKE_SCRIPT=/tmp/vibego-fresh-reload-smoke-debug.mjs /tmp/vibego_final_blockterm_fresh_smoke.sh 24351 30301`；证据目录 `/home/xxnuo/vibego-smoke-runs/vibego-final-blockterm-20260828-062147-hRICHW`，实际 x86-64 ELF SHA-256 `2b3c251bd6d4127c92a5b4677c91384dd2f41602b20d4e907b158bf8dfd6508f`，`SMOKE_STATUS=passed`。覆盖 scope restore/reload、active tab、长命令、Stop/recovery、note/comment、Mustache、1.2 MiB 输出、raw ANSI/NUL/非法 UTF-8、trim、cursor gap、history pagination；页面生命周期取消的 output 请求为预期 `ERR_ABORTED`，不计作失败。xterm buffer hook 只在该显式测试开关下编译启用，随后重跑的默认 `pnpm run build` 产物不含 hook 标识。
- 最新静态/动态 completion 浏览器 smoke 证据目录 `/home/xxnuo/vibego-smoke-runs/vibego-completion-20260828-063651-8ab3d6`：`status=passed`，实际 x86-64 ELF SHA-256 `caba33f1c3b95885fec5b614c1971c1c1f8721dbe11496b9a305e409ca8df163`。验证 ghost suffix 与 `ArrowRight`、subcommand/flag/描述/去重、嵌套命令、动态文件补全和 cwd 更新；另验证 `git status --no` 不泄漏 root `--no-pager`、`git switch -c topic --` 不重复提供 `--create`，以及 `sudo -u root git st`、`env -u FOO git st`、`command -p git st` 均完成为 `status`。`requestFailures`、`badResponses`、`consoleErrors` 和 `pageErrors` 均为空，smoke 端口与进程已清理。
- detached interruption smoke：`/home/xxnuo/vibego-smoke-runs/vibego-detached-interruption-NzOQHm`（A→B，block `mtc06cwi-lnegd7`，最终 `interrupted`/`exit_code=null`）和 `/home/xxnuo/vibego-smoke-runs/vibego-detached-return-loaded-uUkaet`（A→B→A，旧 block 重新挂载后再释放 POST，block `mtc0mfpa-vftn8l`，最终 `interrupted`/`exit_code=null`）；对应实际 x86-64 ELF SHA-256 `a2c38e55af8d789201b52ec6f20fa1a8b6f870be52209cf20fc4e4c5f30d5a14`。同 groupId 保持同一组件实例的专门切换尝试未取得通过证据，不作为验收结论。
- 最新 need-key Renderer/sidebar/process identity 浏览器 smoke 证据目录 `/home/xxnuo/.cache/vibego-smoke-evidence/vibego-renderer-sidebar-20260827-192057-9FFb1i`：`status=passed`，实际 x86-64 ELF SHA-256 `d76401ccbeb1fadbeb01e3126a9c4fa97a5970d6230114dcf827daa104363480`。验证 `none -> terminal` 切换并恢复 xterm marker；侧栏宽度 `692px -> 500px -> 692px`、刷新恢复、关闭后 owner 保留；`/comment` note 移入侧栏后只渲染纯文本且没有 xterm，移回主列表后内容保留；连续两次 view PATCH 失败后 UI 回滚到服务端最后确认的关闭状态。本地 `sleep 5` 的 shell PID 为 `4012835`，前台进程组 leader 与持久化 `cmd_pid` 均为 `4012936`，短命令 `cmd_pid=null`。`badResponses`、`consoleErrors` 和 `pageErrors` 为空，output PUT 的 `ERR_ABORTED` 为页面切换时取消的预期请求。
- 最新 PTY binary/Renderer 浏览器 smoke 证据目录 `/home/xxnuo/.cache/vibego-smoke-evidence/vibego-renderer-sidebar-20260827-192252-qrRsUs`：使用同一 SHA-256 `d76401ccbeb1fadbeb01e3126a9c4fa97a5970d6230114dcf827daa104363480` 的实际 ELF，通过 UI 分别执行 `cat` PNG 和 PDF。raw endpoint 返回的 PNG `69` 字节和 PDF `587` 字节均从格式签名开始、无前后 framing 字节，长度和 SHA-256 与源文件逐字节一致；image Renderer 实际解码为 `1x1`，PDF Renderer 的 blob 为 `application/pdf` 且浏览器回读 SHA-256 一致。`badResponses`、`consoleErrors` 和 `pageErrors` 为空。
- 最新当前树 2500 块浏览器虚拟化 smoke 证据目录 `/home/xxnuo/.cache/vibego-smoke-evidence/vibego-virtualization-current-20260827-192333-ZqAY1I`：复用上述实际二进制和 HEAD `a6423c2407cb503edf3a3872a21afff1fea7a76d`，`source-newer-than-binary.txt` 为空。initial/bottom DOM 为 `7/8`，virtual height `304854`，底部 `scrollTop=max=307112`，Home/End 和 terminal 重挂载 marker 均通过；`requestFailures`、`badResponses`、`consoleErrors`、`pageErrors` 均为空，端口和进程已清理。
- 最新真实 SSH 浏览器 smoke 证据目录 `/home/xxnuo/.cache/vibego-smoke-evidence/vibego-ssh-ui-min-20260827-192534-ZyZPCA`：临时 OpenSSH 的 host-key challenge、私钥口令、PTY、远程 cwd、`132x43` resize、仅 INT stop 和停止后继续命令均通过；浏览器未请求 process identity，直接调用 SSH process identity API 返回预期 501。`badResponses`、`consoleErrors` 和 `pageErrors` 为空，三个端口均已释放；实际二进制 SHA-256 `88f9939a17ea3e7186bb24ac72a1210469a5e2ec43fd1a6fab60ea76301a984b`。
- 最新 raw PTY 分段实际二进制浏览器/API smoke 使用 `TMPDIR=/home/xxnuo/vibego-build-tmp VIBEGO_RUN_BASE=/home/xxnuo/vibego-smoke-runs /tmp/vibego_final_blockterm_integration_smoke.sh 23141 30224`，证据目录 `/home/xxnuo/vibego-smoke-runs/vibego-final-blockterm-20260827-130618-qGlYE4`；`SMOKE_STATUS=passed`，实际二进制为 x86-64 ELF，SHA-256 `55c8b5ed8a64b6c389fe95332ed2697de2533cd9a9132167eaed6c82098c2991`。验证 raw PTY `1,200,068` 字节（填充 `1,200,000`，cursor `2200` 到 `1202268`），ANSI、NUL、`0xff` 保留且 OSC marker 未泄漏，xterm 颜色可见；trim 将 `6056` 字节缩至 `256` 并前移 start cursor、保持 end cursor，cursor gap 查询分别得到 `abcdefgh`、`cdefgh`、`efgh` 和 end/ahead 空结果；history 分页为 `100 + 5`（offset `0/100`）。`badResponses=[]`，失败请求仅为预期的 `PUT .../output` `net::ERR_ABORTED`，smoke stderr 为空，服务日志仅有既有 settings 404 警告，无 panic/fatal/data error，23141/30224 已释放。
- 历史 lifecycle/registry 实际二进制浏览器/API smoke 证据目录 `/home/xxnuo/vibego-smoke-debug/vibego-final-blockterm-20260827-071153-ZYkQJI`：`SMOKE_STATUS=passed`，ELF SHA-256 `0a600a74affe505bc3d8a96359e0a83ec51e28f781643daa14f45e660137fbc6`；验证本地只写 `cmd_pid`、SSH 只写 `remote_pid`、几何与 before/after state 持久化并在刷新后保留，UI lifecycle metadata 可见，同时复验 Stop 边界、1,200,065 字节 raw output、history 100+5 分页、Mustache 清洗和 note/comment 非执行语义。`badResponses=[]`，日志无 panic/fatal/error/data race，22421/29521 已释放。
- 历史最终实际二进制浏览器/API smoke 使用 `/tmp/vibego_final_blockterm_integration_smoke.sh 22431 29531`，证据目录 `/home/xxnuo/vibego-smoke-debug/vibego-final-blockterm-20260827-072316-qA1tmA`；`SMOKE_STATUS=passed`，ELF SHA-256 为 `0376a5fdb3d497fa1e04e46b4ae708d2e74911e7fd2ab3bbb2a66d0c8a3182df`。证据包含 Stop 后 47ms 提交新命令且只发送 `INT`、note/comment 不触发 PTY/history、Mustache 清洗危险元素和属性均为 0、1,200,065 字节 raw output（填充 1,200,000 字节、cursor 287）及 PUT、history API/UI 分页 100+5（offset 0/100）；`badResponses=[]`，失败请求仅为可忽略的 `ERR_ABORTED`，smoke stderr 为空，服务/Chrome 日志无 panic/error/race，22431/29531 已释放。
- Renderer 隔离批次以 staged patch 应用到 `74ce979` detached worktree `/tmp/vibego-renderer-isolated-prgOJh` 验证：`pnpm run check`、43/43 Node tests、`pnpm run build`、`go test ./... -count=1 -timeout 300s`、`go test -race ./... -count=1 -timeout 300s`、`go vet ./...`、`go build ./...` 和 `git diff --check` 全部通过。
- need-key 实际二进制浏览器 smoke 证据目录 `/tmp/vibego-renderer-host-20260826-222123-PEW42q`：code 5、Markdown 2、CSV/image/PDF/media 各 1，下载 SHA-256 一致，PDF 非白像素比 0.3625，媒体 Range 为 206；同 URL 续期不重挂载，资源错误可重挂载，URL 轮换恢复媒体状态，2 秒短 TTL 自动续期；`badResponses`、`requestFailures`、`consoleErrors`、`pageErrors` 均为空。
- 无鉴权浏览器 smoke 证据目录 `/tmp/vibego-renderer-noauth-SReQOg`，同一组 Renderer、下载、PDF 和媒体验证通过，PDF 非白像素比 0.6116，媒体 Range 为 206，页面与网络错误列表均为空。独立 HTTP CookieJar 证据目录 `/tmp/vibego-view-session-http-zPTtkK` 验证两个同 key 浏览器 URL 不同、交叉 Cookie/URL 与无 Cookie 均 401、Range 206、当前浏览器 logout 后旧 Cookie 重放 401，另一浏览器仍为 200。
- 导航与历史批次验证通过：将本批 staged patch 应用到 `c5fbb78` detached 临时 worktree 后，`cd ui && node --test tests/*.test.mjs` 为 29/29，完整 `pnpm run check`、`pnpm exec tsc -b --pretty false`、`pnpm run build` 和 `git diff --check` 全部通过。共享工作树中的并行 Git 桌面代码曾使全仓 UI/Go 验证中断，因此 Go 全套也在 detached 临时 worktree 中复用当前 `ui/dist` 隔离验证，`go test ./... -count=1 -timeout 300s`、`go test -race ./... -count=1 -timeout 300s`、`go vet ./...` 和 `go build ./...` 全部通过。
- 导航与历史浏览器 smoke 使用当前 Vite 源码和已验证基线后端二进制，证据目录 `/tmp/vibego-nav-history-20260826-Fl5evM`。实际验证置顶后的视觉/键盘顺序、六种导航键、归档/隐藏/删除后的邻近焦点、拖选文本不改 selection，以及空/非空草稿历史往返；结果 `status=passed`、`failures=[]`、`badResponses=[]`，截图 SHA-256 为 `a514ebcd94e1d12b11a7570586ca57d517df065fd68d3af83bb7bea72e5002ad`，端口 `15174`、`22146` 及对应进程已退出。Vite 仅记录既有 SideBar 列表 key 警告。
- 耐久化历史批次以 history-only patch 应用到 `901f433` detached worktree `/tmp/vibego-history-901-final-oR7AUL/worktree` 验证：`go test ./... -count=1 -timeout 300s`、`go test -race ./... -count=1 -timeout 300s`、`go vet ./...`、`go build ./...`、`cd ui && pnpm run check`、`cd ui && pnpm exec tsc -b --pretty false`、`cd ui && node --test tests/*.test.mjs`、`cd ui && pnpm run build` 和 `git diff --check` 全部通过，Node 测试为 51/51；同一 patch 与 GitHub staged 快照组合后再次通过完整 Go/UI/race/vet/build 验证，Node 测试为 52/52。
- need-key 实际二进制耐久化历史 smoke 证据目录 `/tmp/vibego-renderer-host-20260826-233152-8umvsv`：验证 block/history 创建先于 PTY 输入、创建失败重试 4 次且不执行、等待创建期间保留新草稿、Renderer 不发 PTY、显式删除 block 后刷新不被 replay 重建且上下键仍读取历史、terminal/workspace 删除后历史保留、`Ctrl-R` Enter/Escape、过期搜索响应保护，以及 socket 失效后标记 `interrupted`；结果 `status=passed`，`badResponses`、`requestFailures`、`consoleErrors`、`pageErrors` 均为空。实际 x86-64 ELF SHA-256 为 `90e70ca14962fbbb5f1f77e4b8730cff7ab4dd61fba8b5a2ac9d2d16564dd37b`，端口 `22183`、`29227` 及对应进程均已退出。
- 最终浏览器/API smoke 命令为 `/tmp/vibego_final_blockterm_smoke.sh 22145 29226`。证据目录 `/tmp/vibego-final-blockterm-20260826-181256-fyxdZE` 中的实际二进制为 x86-64 ELF，SHA-256 `30a4f3da115aabb3c835e84a2983371995e41d57809b78a5d43651f89f77873c`；`SMOKE_STATUS=passed`，`smoke.stdout.json` 记录 `blockCount=2`、`failures=[]`、`badResponses=[]`，成功/失败命令、长命令与 active terminal 在 workspace 快速切换后均正确恢复。服务、应用、Chrome、构建和 smoke 日志无 panic、fatal、error 或 data race，端口 `22145`、`29226` 及对应进程均已退出。
- 较早的隔离 HTTP/WS smoke 使用二进制 `/tmp/vibego-final-e2e-20260826`（SHA-256 `b5aab1bd17689d02dae50e30514874d065798f1518da225b5fc89ea6ca9011f3`）、端口 `22001` 和独立数据库。真实 WebSocket 验证 `replay_done`、`state`、命令输出和 `pty_exited`，并验证 BlockTerm 查询；此前 Git smoke 验证初始化、提交、带空白的 tag 创建/删除及危险 Init 参数拒绝。
- 较早的 Playwright smoke 在 1440x1000 下验证成功命令、失败命令、`less /etc/hostname` TUI、刷新后 block/output 与置顶/收藏状态恢复；其二进制早于本次本地标签边界修复，只作为 UI 交互历史证据。
- 端口 `22001` 的服务日志包含既有 CDP `29222` 页面访问旧 session 产生的 404 噪声；独立 Playwright smoke 未连接或操作该浏览器，前述页面侧结果不包含这些请求。
- 较早的 `21986` smoke 验证过停止长命令后以 `interrupted`、`exit_code=null` 持久化，以及停止、重跑和块操作；其二进制早于最终 scope generation 修复，只作为这些交互的历史证据，不证明最新 scope 修复。
- speculative terminal 的旧 scope 响应现已通过 delete/close 补偿，不再保留“服务端创建后无法撤销”的旧边界。
- terminal 或 workspace 删除会先关闭 PTY，再执行数据库删除事务。关闭 PTY 属于不可回滚的外部副作用；若后续数据库事务失败，数据库记录仍在，但原 PTY 进程无法恢复。
- 当前 block 展示投影只保留最后 200000 个字符，完整值独立保留；raw PTY 由 recorder 按 OSC 边界分段持久化，`raw-output` API 支持 cursor 增量读取并在无 segment 时回退 legacy output；展示缓存仍是整份快照 PUT。服务端和客户端均以 16 MiB 为单块硬上限，超过上限返回 413，不会静默覆盖为尾部；命令默认 `terminal` renderer 使用 raw PTY，未知或损坏 renderer 的文本回退仍会去除 ANSI。
- 当前 block/history 的 connection、cwd、output、geometry 和最终状态可持久化，但 PTY owner 与运行进程仍依赖 HTTP 服务生命周期；服务重启不能恢复运行进程，启动清理会把遗留 running session/block 收尾为 `exited`/`interrupted`，不会伪造重附着。真实恢复仍需独立 PTY owner/broker，SSH shell 协商也仍有限。
- 当前已知故障边界：terminal list 恢复请求失败会落入新建 session，block inventory 恢复失败会静默显示空列表；block DELETE 最终失败会被吞掉，乐观 tombstone 使当前 scope 持续隐藏记录，刷新后可能复活。上述失败恢复流程尚无对应浏览器或流程测试。
- 仍未完成或未纳入本阶段：独立于 HTTP 服务生命周期的 PTY owner/broker 与服务重启重附着、完整 Fig catalog、SSH shell 协商、独立 line/cmd 数据分层、history 的具体 SSH profile/common command 筛选、composer 的 exact completion context、完整 shell state、按用户隔离的模型配置/secret、真实外部模型 provider，以及移动端专用布局。per-block local/SSH connection、`/connect`、History Copy/Use、multi-child exact resize 与 geometry 持久化已纳入。

### 后续记录格式

每个阶段单独提交，并记录：变更范围、参考文件、验证命令、实际运行结果和未覆盖边界。
