你需要阅读 docs/ 中的文件来理解项目的设计，然后遵循要求进行开发

## 开发与排查日志

- `make dev` 并行启动后端 Air 和前端 Vite；也可单独运行 `make dev-server`、`make dev-ui`。
- 开发命令的标准输出和错误输出会同时显示在终端并追加到项目调试目录 `temp/dev/logs/`：后端为 `dev-server.log`，前端为 `dev-ui.log`，`make desktop-dev` 为 `desktop-dev.log`。
- Agent 在开发、验证和排查问题时，可先用 `tail -n 200 temp/dev/logs/dev-server.log` 或对应前端、桌面日志查看近期输出，再用 `rg -n '关键词' temp/dev/logs/` 定位错误。后端自身的应用日志也位于该目录。
- 日志追加保留，每次启动有时间标记；结合启动时间区分历史错误与当前问题。目录已被 Git 忽略，不要提交调试数据，也不要为了查看日志重复启动或重启已有开发服务。
