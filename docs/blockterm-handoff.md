# BlockTerm 阶段暂停与接手报告

状态：按用户要求暂停，整体目标未完成。此报告是恢复工作的入口；完整过程保留在 [blockterm-core-progress.md](blockterm-core-progress.md)，旧 WaveTerm 记录 [blockterm-port.md](blockterm-port.md) 仅供历史追溯。

## 1. 目标与方向

参考本项目普通 TerminalPage 的整体设计，交付支持命令块的传统终端、可编辑输入区域和自动补全。参考 `warp` 的成熟核心实现，优先块输出、提示符编辑、补全的连续 UI 体验，不移植应用框架、分页、主题、编辑器或 AI 工作台。

Warp 本地参考版本：`e3464f102afddeb48433979bc1d9fee653f500ad`。当前主要是参考其行为后在 Go/React 中独立实现，并非直接复制其原生核心。后续应明确哪些部分能复用，哪些只能做平台适配，不能把“行为参考”写成“已直接移植”。

## 2. 权威代码基线

- 暂停核查时 HEAD：`ecbd169023bd1233c1d50621627807d596fb1758`，标题 `feat(blockterm): implement continuous shell core and command block interface`。
- 暂停报告创建前工作区干净。
- 当前历史已整合。`git diff --stat 965d5db HEAD` 无输出，确认当前代码树与最后阶段提交一致；过程记录中的旧阶段哈希是历史证据，不应假设仍在当前主线祖先链上。
- 本次暂停只新增本报告，不修改功能、不部署、不清理历史或测试数据。

## 3. 已实现内容

| 领域 | 当前实现 | 不能扩大解释为 |
| --- | --- | --- |
| 终端核心 | 独立 Go PTY、连续 Shell 状态、生命周期事件、命令块状态、退出码、输出持久化、检查点与回放恢复 | 跨服务重启 PTY 重附着、完整 Warp 等价 |
| 输出渲染 | 连续终端解析、活动输出与静态块、正常屏/备用屏、交互式程序、块虚拟列表 | 所有终端序列及平台均实机验证 |
| 输入 | 多行编辑、选区与编辑动作、IME 保护、撤销恢复、按会话隔离草稿、历史回溯与行内建议 | 完整原生编辑器、刷新后草稿持久化 |
| 补全 | 命令/子命令/选项建议、路径候选、随输入筛选、Tab/方向键/Enter 选择、原生 Shell 回退 | 所有 Shell 的完整语义补全、SSH 补全 |
| 块操作 | 折叠、选择、键盘浏览、复制、下载、编辑与显式重跑、输出搜索 | 用户核心终端体验已经交付 |
| 滚动与规模 | 输出跟随、阅读时停止跟随、返回最新、2500 块有界 DOM、动态尺寸处理 | 完整 Warp Waterfall clear/gap 模型 |
| 稳定性 | 控制权、断线/同步状态、输入队列保护、分页和异步结果隔离、错误恢复 | 所有故障路径都已生产验证 |
| 页面整合 | 接入共享顶部导航，移除正文重复会话栏，手机紧凑标题和触控按钮 | 普通终端会话标签、键盘及整体交互完全一致 |

完整细节、发现过的问题、每阶段验证与限制见过程记录，不用阶段数量代表成熟度。

## 4. 最后四阶段：真正影响主界面的改动

1. **382**：会话切换、Shell 选择、新建接入共享顶栏。真实页面不再重复渲染会话栏，独立测试嵌入保留兼容入口。
2. **383**：空闲短输出后直接接编辑区，长历史可滚动；运行程序仍使用完整视口。PTY 行数按可用容器尺寸计算，不能被短输出高度压缩。
3. **384**：桌面编辑与历史/补全/执行同排，默认快捷键说明不再常驻占一行；手机保留完整输入宽度与 44px 操作区。
4. **385**：补全候选改为输入区域旁的浮层，不挤占输出高度；依据上下空间展开、限制视口边界。首次回归发现浮层挡住补全按钮，已将定位边界从文本框改为整个输入区，修复后回归通过。

最后阶段旧哈希依次为 `c4f305e`、`f07972d`、`04eaff3`、`965d5db`；恢复以当前整合基线为准。

## 5. 为何用户体感改善不足

- 大量工作落在底层边界、菜单、搜索、焦点和回归测试，整体输出与输入布局的优先级过低。最近才开始明确向普通终端主界面收敛。
- 之前小阶段过多，测试通过并不证明终端整体体验好用。不要继续围绕菜单和搜索增加外围功能来代替核心交付。
- 开发源码与常驻服务不是同一版本。没有部署常驻服务；用户究竟使用哪个入口尚未确认，不能把所有体感问题都归因于旧版本。

## 6. 代码导航

| 路径 | 用途 |
| --- | --- |
| `ui/src/components/blockterm/page.tsx` | 当前页面入口、会话生命周期、块列表、输入与补全协调；文件较大，先定位功能再改 |
| `ui/src/components/blockterm/engine.ts` | 连续终端、事件与回放协调 |
| `ui/src/components/blockterm/api.ts` | 新核心前端协议与 API |
| `ui/src/components/blockterm/completion-overlay.tsx` | 最新补全浮层、视口定位与监听释放 |
| `ui/src/components/blockterm/path-completion.ts` | 路径补全解析与候选 |
| `ui/src/components/blockterm/drafts.ts`、`use-session-draft.ts`、`command-edit.ts`、`input-history.ts` | 输入状态与编辑 |
| `ui/src/components/blockterm/block-output.tsx`、`live-viewport.ts`、`scroll-follow.ts` | 输出呈现与跟随 |
| `ui/src/components/blockterm/session-controls.tsx`、`action-menu.tsx` | 顶栏会话控件与块菜单 |
| `internal/service/blockterm/` | 当前独立后端核心及测试 |
| `internal/handler/blockterm_v2.go` | 新核心 HTTP/WebSocket 接入 |
| `ui/src/components/terminal/terminal-page.tsx` | 应遵循的普通终端页面设计 |
| `docs/UI 设计风格.md` | 页面框架、移动优先与视觉约束 |

旧 `ui/src/components/terminal/blockterm-*`、旧 handler/model/service 仍有遗留和共享依赖。当前补全仍复用部分旧目录纯函数；不能直接整目录删除，也不要误将旧大页面作为本轮主要入口。

Warp 重点参考：`app/src/terminal/model`、`view.rs`、`block_list_viewport.rs`、`waterfall_gap_element.rs`、`input/terminal.rs`、`input/common.rs` 及 `crates/warp_terminal`。

## 7. 验证证据与边界

本次暂停只核实代码状态、记录和日志，没有重新运行全套测试。

- 阶段 383：TypeScript、Biome、构建、完整草稿与 2500 块专项成功，已确认进程 exit 0；真实命令与可选 Vim 流程成功，查看 320/1280 布局截图。构建仍有既有大 chunk 警告。
- 阶段 384：TypeScript、Biome、真实入口流程通过，桌面截图确认少一行编辑区占高。
- 阶段 385 最终代码：TypeScript、Biome、diff 检查、完整草稿专项和真实入口专项通过。补全新增断言覆盖提示符纵坐标稳定与浮层不越视口。最终截图确认不遮挡输入操作按钮。
- 阶段 385 没有重新做全量后端测试、完整生产构建或 Vim 专项；不能将较早结果称为最终代码的全量验收。
- 浏览器覆盖 320/390/1280 视口，不等于手机设备/WebView/软键盘实机验收。Windows/macOS、SSH 也不能由 Linux 本机结果推定。
- 测试建立的自身会话已结束，历史保留；没有删除用户记录。

本机临时证据（可能清理失效，不提交）：

- `/tmp/vibego-step383-{drafts,virtual,build,real}.log`
- `/tmp/vibego-step385-drafts-final.log`：完整草稿成功。
- `/tmp/vibego-step385-real-position.log`：最终真实入口成功，`pageErrors: []`。
- `/tmp/vibego-real-entry-command-completion.png`：最终手机补全浮层截图。
- `/tmp/vibego-real-entry-flow-{320,1280}.png`：流式短输出与输入布局，文件会被后续运行覆盖。
- 最终真实验收主会话：`9dacabdf-3177-488e-8518-bf7e70771635`，已结束并保留历史。

恢复时按改动风险选择现有流程，不为微小改动重复全矩阵：

```sh
cd /home/xxnuo/projects/VibeGo/ui
pnpm run check
pnpm exec tsc -b --pretty false
BLOCKTERM_SMOKE_ONLY=blockterm-v2-drafts-smoke.mjs node tests/run-blockterm-browser-smoke.mjs
BLOCKTERM_SMOKE_ONLY=blockterm-v2-virtual-smoke.mjs node tests/run-blockterm-browser-smoke.mjs
BLOCKTERM_REAL_ENTRY_URL=https://127.0.0.1:11984 node tests/blockterm-v2-real-entry-smoke.mjs
```

需要交互式终端验收时为最后一条增加 `BLOCKTERM_REAL_VIM=1`。真实入口脚本会创建自身会话并留下已结束历史，不要无目的重复运行。隔离 runner 默认使用 29731，可通过 `BLOCKTERM_TEST_PORT` 区分；不要在运行期间修改源码导致 HMR 干扰。

## 8. 暂停时运行环境

| 服务 | 现场状态 | 注意 |
| --- | --- | --- |
| 常驻安装版 | PID 995，HTTPS 10088 | 仍为原打包入口，未部署本轮变化 |
| 开发后端 | PID 2528096，HTTPS 11984 | 当前源码开发入口，转发 Vite |
| Vite | PID 2489698，15173 | 当前源码 HMR |
| 隔离测试 | 29731/29732 均未监听 | 本轮无遗留测试服务 |

PID/端口是暂停时快照，恢复必须重新核实。本次未停止或重启上述用户服务。开发日志在 `temp/dev/logs/`，先读已有日志，不为排查重复启动服务。

## 9. 未完成项与建议恢复顺序

1. **先确认用户实际入口和期望画面**。在当前开发入口审视连续命令、多行编辑、长历史与补全的完整工作流，而非再做外围功能；发布/重启另行确认。
2. **完成真正连续的输出—提示符布局**。现状只是短输出随流、长历史底部编辑；尚未实现完整共同滚动、clear/gap 语义。避免直接破坏 PTY 可用尺寸、备用屏和阅读位置。
3. **完善编辑和补全衔接**。真实手机软键盘、候选上下展开、长候选、输入法、多行、焦点与普通终端键盘整合；历史列表仍是占据布局的原面板。现有浮层仅观察输入框与页面尺寸，涉及输入区动态结构时需复核定位。
4. **保持整体设计一致**。会话目前仍为下拉控件，未达到普通终端标签/管理交互的一致性；按用户核心需求决定是否调整，不扩展另一套工作台。
5. **只补必要验证与收尾**。基于真实失败修复，复用已有测试。旧源码清理需先核查依赖；跨平台、SSH、高级语义补全和跨服务重启 PTY 重附着未完成，是否纳入下一交付阶段应明确确认，不能用它们无限扩展当前 UI 任务。

恢复完成标准应以用户可见的普通终端连续体验、可编辑输入和顺手补全为主，再配合相应真实运行证据；不以阶段数、提交数或测试数替代。用户已要求阶段暂停，未获恢复指示前不要继续功能开发，也不要将目标标记为完成。
