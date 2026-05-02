# Git 桌面端移植台账

本文档记录 GitHub Desktop `development` 分支到 VibeGo 桌面端工作区的移植范围、当前状态和验证证据。

## 范围约定

- 桌面端指 VibeGo 现有浏览器工作区在桌面视口中的 Git 工作流，不新增 Electron 壳。
- Git 执行继续由 VibeGo Go 后端调用宿主机 `git`，前端通过现有 HTTP/WebSocket 接口工作。
- 第一阶段覆盖本地仓库日常操作和远程同步；移动端布局与 GitHub 在线服务另行适配。
- 参考项目中的 Electron IPC、系统托盘、内置 Git、GitHub OAuth/API 和品牌资产不直接复制。

## 功能台账

| 功能组 | 参考项目能力 | VibeGo 状态 | 验收证据 |
| --- | --- | --- | --- |
| 仓库 | 打开、识别、初始化、克隆、缺失仓库状态 | 已有接口并接入桌面工作区 | Go handler tests + UI build |
| 变更 | 状态分组、文件选择、暂存/取消暂存、放弃、过滤 | 已接入文件、hunk 和 line 选择，以及暂存、取消暂存和放弃 | status/diff/apply tests + real repo |
| 差异 | 文本 diff、hunk/line 选择、二进制提示、历史 diff | 已有交互文本 diff 和历史 diff；二进制和超限文本返回有界预览并关闭行级选择；PNG/JPEG/GIF/WebP/ICO/BMP/AVIF 提供受限 base64 图片 diff（工作树、暂存和历史） | diff/bounds/image tests + HTTP smoke + UI build |
| 提交 | 摘要/描述、部分提交、amend、提交钩子结果 | 已有普通/部分提交、amend、undo，并在部分提交后恢复 index；支持跳过 hooks、Signed-off-by trailer 和 allow-empty，提交成功后只清理摘要/描述/amend/选择及 allow-empty 草稿 | commit/options tests + real repo |
| 历史 | 分页、文件列表、提交 diff、撤销最新提交、标签 | 已有分页、提交文件/diff、undo 和 tag；支持 reflog/最近分支/不可达提交恢复、提交多选和右键操作，提交详情可直接 cherry-pick、revert、mixed reset，历史工作区支持 squash/reorder | history/recovery/operation tests + HTTP/browser smoke |
| 分支 | 本地/远程列表、切换、自动 stash、创建、删除 | 已接入创建、重命名、普通/强制删除本地分支、远程跟踪分支 checkout、删除远程分支和 prune；分支及 remote/ref 输入会规范化并校验 | branch/input tests + bare-remote checkout/delete/prune tests |
| 远程同步 | fetch、pull、push、force push、发布入口 | 已接入并能判断 publish；真实认证和交互式凭据待补 | sync tests + local bare remote |
| Stash | 列表、文件/差异、恢复、删除 | 已接入 list/files/diff/pop/drop；桌面和移动工作区支持只读文件/差异详情，并在 stash 索引变化或请求过期时清理选择状态 | stash tests + rename/diff tests + UI build |
| 冲突 | 冲突文件、ours/theirs/base/manual、继续/中止操作 | 已有结构化 details、ours/theirs/manual/line-map resolve、operation status 和 continue/abort；details hash 防旧内容覆盖，并拒绝 Git metadata/symlink alias；rebase/cherry-pick/revert 支持 skip | conflict/hash/path-guard tests + real repo |
| 高级历史 | merge、rebase、cherry-pick、revert、squash、reorder | merge、rebase、cherry-pick、revert、squash、reorder 和 soft/mixed/hard reset 已接入 | operation tests + HTTP smoke + browser smoke |
| 仓库设置 | Git 身份、远程 URL、`.gitignore`、LFS、submodule、worktree | 已接入 Git 身份、fetch/push URL、`.gitignore`、LFS 状态/初始化、worktree 增删移动和 submodule 列表/初始化/递归更新/强制恢复；每个已列出的 worktree 提供“打开工作树”入口并复用 `openFolder` | repository/worktree/submodule tests + HTTP smoke + browser smoke |
| GitHub 集成 | 登录、发布、PR、Issue、规则检查 | 已接入账号、PAT、OAuth authorization-code、device flow、远程解析、发布、PR、Issue、commit status/check runs、Actions runs/jobs/steps、check suites、organizations 和 rerun；支持 Enterprise host 派生与检查结果分项降级；GitHub HTTPS Git 操作使用短时 askpass | GitHub client/handler tests + checks/device-flow Node tests + UI build; live provider auth pending |

## 实施记录

### 2026-08-26：基线与边界

- 已确认参考仓库为 `thirdparty/desktop` 的 `development` 分支，HEAD `b17e06dd0f`。
- 已确认 VibeGo 为 Go/Gin + Vite/React，前端通过 `ui/ui.go` 嵌入 Go 二进制。
- 基线验证：`go test ./...`、`cd ui && pnpm run build` 通过。
- 当前阶段目标：补齐桌面端基础 Git 工作流，并以真实临时仓库和浏览器工作区验证。

### 2026-08-26：桌面工作区与本地 Git 工作流

- 桌面工作区已接入 status、diff、文件/hunk/line 选择、暂存/取消暂存、放弃、commit、partial commit、amend、undo、history、tag、branch、远程同步、stash 和冲突解决。
- partial commit 只提交所选文件或 patch，并在完成或失败后恢复调用前的 index，避免把用户原有 staged 内容混入或丢失。
- 分支输入先 trim，并接受 `refs/heads/` 前缀；随后用 `git check-ref-format` 同时校验完整本地 ref 和 branch 名，拒绝 revision shorthand、控制字符和参数注入。
- ref、remote、tag、仓库相对路径、pathspec、symlink 越界和 Windows drive 路径均在进入 Git 命令或文件操作前校验。
- diff 预览和 patch 均有大小上限；二进制、超限文本和截断内容带有元数据，且关闭行级部分选择。

### 2026-08-26：高级历史与操作安全

- 新增 `/api/git/operation-status`、`merge`、`rebase`、`cherry-pick`、`revert` 和 `reset-to-commit` 路由；前端接入 start/continue/abort/skip 及 soft/mixed/hard reset。
- operation status 从 Git 目录读取真实操作状态；`.git/rebase-apply/applying` 被识别为 `git am`，不会误报成可由 rebase API 继续或中止的 rebase。
- merge、rebase、cherry-pick 和 revert 启动前拒绝已有 staged 内容；continue 只允许操作自身涉及的 staged path，可按请求显式 stage 已校验文件，并拒绝无关 staged path。
- Continue 守卫的真实 HTTP smoke（对应当时构建的二进制 SHA-256 `885812cf20a18d3773b93c5a8ab30526c00e78499ea2d296787b658b392a1b82`、端口 `23178`）制造 merge conflict 后额外暂存当前分支独有的 `current-only.txt`，Continue 返回 HTTP 400 和 `unrelated staged path \"current-only.txt\"`；拒绝前后 HEAD、index、cached diff 及 operation status 保持不变，其中 operation status 做了字节级比较。该 SHA 仅作为 merge ownership guard 的黑盒证据，不代表其后的 mainline 构建。

### 2026-08-26：高级历史与仓库设置补齐

- 新增 squash/reorder 历史操作，使用受限的 interactive rebase todo/editor；拒绝重复、越界、非祖先范围、merge commit 和已有 staged 内容。
- 新增仓库设置界面与接口：Git identity、remote fetch/push URL、`.gitignore`、Git LFS 状态/初始化和 worktree 增删移动；省略 `pushUrl` 保留原值，显式空字符串清理 push URL。
- Git 历史无标签提交统一返回空标签数组；前端仍兼容旧服务返回的 `null`，避免历史列表崩溃。

### 2026-08-27：子模块与 GitHub 在线服务

- 新增 submodule 列表、初始化/递归更新、强制恢复和 gitlink diff；结构化 status/diff 显示嵌套仓库提交、修改、未跟踪和冲突状态。自动更新只使用 `protocol.file.allow=never`，显式设置操作才可由用户开启本地 file protocol。
- GitHub REST 客户端与桌面面板已接入账号、PAT、OAuth authorization-code、device flow、发布、PR、Issue、commit status/check runs 和 rerun。OAuth callback 为公共路由，其余 API 受 VibeGo API key 保护；token 保存前通过 `/user` 验证且不返回给浏览器。
- GitHub remote 支持 HTTPS/SSH/SCP-like 解析并清理 userinfo；handler 拒绝与配置 API host 不匹配的 Enterprise/任意 host。GitHub HTTPS fetch/pull/push/clone/submodule 更新使用短时 askpass，token 只进入子进程环境，并清除 credential helper。
- device flow 仅对 `authorization_pending`/`slow_down` 继续轮询；过期、拒绝、网络错误会停止并显示错误。provider 返回的 verification URI 仅接受无 userinfo、合法端口的 HTTP(S)。

### 2026-08-27：分支管理、仓库入口与 stash 详情

- 分支选择器现在区分本地分支和 `remote/branch` 远程跟踪引用；选择远程引用时会创建 tracking local branch（已有同名本地分支则直接切换），并沿用包含未跟踪文件的自动 stash/恢复流程。自动恢复按稳定 stash OID 使用 `--index`，保留原有 staged/unstaged 状态；恢复冲突会保留 stash 并返回 `stashConflict`/`stashError`，远程 checkout 返回结构化 status 供工作区立即刷新。HEAD 尚无首个提交时 Git 无法创建 stash，此时直接 checkout，由 Git 保留非冲突 staged/untracked 文件并拒绝会被覆盖的路径。
- 分支菜单补充本地重命名、普通/强制删除、远程分支删除和远程跟踪引用 prune；远程删除目标限定为 `refs/heads/<branch>`，避免同名 tag 产生歧义。新增真实临时 bare remote 测试覆盖 tracking checkout、已有本地分支、stash 恢复冲突、远程删除和 prune。
- 非仓库状态增加创建/初始化和 clone 对话框，复用目录选择器，操作成功后自动打开新仓库。stash 列表在桌面和移动工作区可展开文件列表及只读 diff，详情和 pop/drop 使用稳定 OID，文件列表使用 NUL 分隔解析并覆盖未跟踪文件与特殊文件名。

### 2026-08-27：冲突、图片差异与提交选项

- `/git/conflict-details` 将冲突文件解析为 plain/conflict segments，并为每个冲突块提供 `ours`、`base`、`theirs` 和稳定 block ID；`/git/conflict-resolve` 支持 ours/theirs/manual/line-map，显式空字符串也是有效的 manual resolution。旧的 `/git/resolve-conflict` 路由继续保留以兼容已有客户端。
- 冲突详情返回基于文件内容的 snapshot hash；resolve 写入前重新读取并比对 hash，内容已被编辑时返回 HTTP 409，不读取阶段内容、不写文件也不改变 unmerged index。冲突详情和解决接口同时拒绝 `.git`（含大小写变体和嵌套路径）以及经过符号链接的 metadata alias，避免读写 Git 控制目录。
- 图片 diff 只接受 PNG/JPEG/GIF/WebP/ICO/BMP/AVIF 等惰性 raster MIME，后端按 4 MiB 单边上限生成 base64 `old/new` payload；工作树、staged 和 commit diff 均可预览，新增/删除图片保留单边显示，超限图片只返回大小/截断元数据并关闭行级选择。前端提供 two-up 和 swipe 两种查看模式，并再次校验 MIME 与 base64。
- 行/hunk 部分选择会携带 `patchHash`；服务端发现 diff 在展示后发生变化时返回 HTTP 409 并要求刷新，避免把旧 patch 应用到新内容。
- 提交 composer 增加 `--no-verify`、`--signoff` 和 `--allow-empty` 选项；API 同时兼容 `skipCommitHooks`、`signOffCommits`、`allowEmptyCommit` 旧字段。真实 hook 测试确认 no-verify 不执行 pre-commit，sign-off 写入 `Signed-off-by` trailer，allow-empty 可创建无变更提交及无选择 amend。提交成功后清理摘要、描述、amend、选择和 allow-empty 草稿，保留 no-verify/sign-off 偏好。

### 2026-08-27：历史操作与工作树入口

- 历史提交详情直接提供 cherry-pick、revert 和 mixed reset；高级历史继续支持 squash/reorder，后端对重复、越界、非祖先范围、merge commit 和已有 staged 内容做拒绝校验，并以受限 interactive-rebase todo/editor 重写历史。
- 仓库设置的 worktree 列表为每个可打开的工作树提供图标入口，点击后复用工作区 `openFolder`，不改变现有 worktree 增删移动流程。
- fetch/pull 的顶层配置 remote 不再固定注入 `protocol.file.allow=never`，因此本地 `file://` bare remote 可用于离线 fetch/pull 验证；自动递归 submodule 更新仍在受限协议上下文运行，显式 submodule 设置才是开启本地 file protocol 的入口。该边界不等同于 SSH/HTTPS 凭据、代理、2FA 或托管平台认证验证。

### 2026-08-27：历史恢复、多选与 Actions 完善

- 新增 reflog、最近分支和不可达提交恢复接口；显式不存在的 reflog ref 返回 400，未出生的 HEAD 仍返回空结果；reflog 和最近分支时间使用 reflog 事件时间，而不是指向提交的作者时间。初始提交也可以 undo，删除分支引用后保留工作树内容。
- 历史列表支持 Ctrl/Meta 多选、Shift 范围选择、Enter/Space 键盘选择和右键菜单；批量 cherry-pick 去重并按 oldest-first 提交，revert、mixed reset、squash、reorder 均复用当前选择。
- GitHub Actions 面板补充 workflow runs、jobs、steps、check suites 和 organizations；支持全量、失败 job、单 job 和 check-suite rerun。check-suite 仅在 `rerequestable`、`completed` 且创建时间不超过 30 天时启用；checks、runs、suites 分项加载，单项失败不丢弃其他结果；按 commit SHA 查询 workflow，避免 branch 与 SHA 不一致漏检。只有 `owner/repo` 请求时，Enterprise API host 会派生为对应远程 host。

## 当前验证边界

- 当前工作树（保留未提交的 BlockTerm 改动）已通过：`go test ./... -count=1 -timeout 300s`、`go test ./... -race -p 1 -count=1 -timeout 300s`、`go vet ./...`、`go build ./...`、`cd ui && pnpm run check`、`cd ui && pnpm exec tsc -b --pretty false`、`cd ui && pnpm run build`、`cd ui && node --test --test-concurrency=1 tests/*.test.mjs`（72/72）和 `git diff --check`。
- handler 测试使用真实临时仓库覆盖日常 Git、partial commit/index 恢复、patch/hash 过期保护、图片工作树/历史预览、提交选项、branch、远程 tracking checkout/删除/prune、stash、conflict metadata/resolve、高级历史和仓库设置；fetch/pull/push/force push 使用本地 bare remote 验证，其中 fetch 覆盖 prune、pull 覆盖无显式 `pull.ff` 时的 fast-forward 默认行为，不代表 SSH/HTTPS 凭据、代理、2FA 或托管平台认证已通过。
- 本轮 HTTP smoke 使用旧二进制 `/tmp/vibego-git-smoke-20260826`（端口 `28741`）；修复后二进制 `/tmp/vibego-git-smoke-fixed-20260826`（端口 `28742`，SHA-256 `e56d387e098acb713a9361df697c98a319b7751ed9d4a227192b083cb7503f79`）实际用于桌面浏览器 smoke。HTTP smoke 真实验证 repository settings、remote push URL 保留/清理、`.gitignore`、worktree 增删、squash/reorder，以及二进制和 `524289` 字节 patch 的有界 diff。
- 本轮桌面浏览器 smoke 使用修复后二进制（SHA-256 `e56d387e098acb713a9361df697c98a319b7751ed9d4a227192b083cb7503f79`，端口 `28742`），检查历史列表及压缩/重排入口、仓库设置面板和高级操作控件；控制台错误和 HTTP 4xx/5xx 均为 0，截图为 `/tmp/vibego-git-ui-fixed.png`。新增 cherry-pick/revert/mixed reset、图片 diff 和 worktree 打开入口已通过 Go/Node/TypeScript/构建验证，但尚未以当前工作树重新做浏览器交互 smoke。
- 本轮新增验证：`go test ./internal/github ./internal/handler -count=1` 覆盖 GitHub client、Actions、OAuth/device 边界、remote host policy、token 保存前账号校验、submodule 状态/diff/update/reset 和 GitHub askpass；`cd ui && node --test tests/github-device-flow.test.mjs tests/github-checks.test.mjs` 覆盖 device flow 和 checks 边界。
- 未覆盖边界：真实 GitHub provider 登录、发布、PR/Issue/Actions/check API、HTTPS 凭据交互、代理、2FA 和 Enterprise 多 host 在线端到端验证；squash/reorder 的后端范围仍受限于线性、非 merge 提交；device cancel 只停止本地轮询，不在 GitHub 服务端撤销 device code；`slow_down` 按现有契约继续轮询但未额外增加间隔。
