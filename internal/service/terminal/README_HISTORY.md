# Terminal 历史管理配置指南

## 数据库大小控制参数

### 1. 历史缓冲区大小 (`historyBufferSize`)

**默认值**: 10MB (10 * 1024 * 1024)

**说明**: 内存环形缓冲区大小,决定了每次持久化的最大数据量。

**推荐配置**:
- 轻量使用: 1-5MB
- 一般使用: 5-10MB
- 重度使用: 10-50MB

```go
terminal.WithHistoryBufferSize(5 * 1024 * 1024)  // 5MB
```

---

### 2. 刷新间隔 (`historyFlushInterval`)

**默认值**: 5 秒

**说明**: 多久持久化一次历史数据到数据库。

**推荐配置**:
- 实时重要性高: 1-5 秒
- 一般场景: 5-30 秒
- 减少 I/O: 30-60 秒

```go
terminal.WithHistoryFlushInterval(10 * time.Second)  // 10 秒
```

**影响计算**:
```
10MB 缓冲区 × 5秒间隔 = 720次/天 = 7.2GB/天/会话
10MB 缓冲区 × 30秒间隔 = 120次/天 = 1.2GB/天/会话
```

---

### 3. 每会话最大历史记录数 (`historyMaxRecords`)

**默认值**: 1 (只保留最新一条)

**说明**: 每个会话在数据库中保留的历史记录条数,超过后自动删除最旧的。

**推荐配置**:
- 只需重连恢复: 1 条
- 需要查看历史变化: 3-10 条
- 完整历史跟踪: 50-100 条

```go
terminal.WithHistoryMaxRecords(3)  // 保留最近 3 次快照
```

**数据库大小估算**:
```
1 条记录 × 10 个会话 × 10MB = 100MB
10 条记录 × 10 个会话 × 10MB = 1GB
100 条记录 × 10 个会话 × 10MB = 10GB
```

---

### 4. 历史最大保留时间 (`historyMaxAge`)

**默认值**: 7 天

**说明**: 历史数据的过期时间,超过该时间的记录会被自动清理。

**推荐配置**:
- 临时使用: 1-3 天
- 一般使用: 7-14 天
- 长期归档: 30-90 天

```go
terminal.WithHistoryMaxAge(3 * 24 * time.Hour)  // 3 天
```

---

## 配置组合示例

### 场景 1: 最小数据库占用 (临时终端)

```go
manager := terminal.NewManager(
    db,
    os.Getenv("SHELL"),
    terminal.WithHistoryBufferSize(1 * 1024 * 1024),      // 1MB
    terminal.WithHistoryFlushInterval(30 * time.Second),  // 30秒
    terminal.WithHistoryMaxRecords(1),                    // 只保留最新
    terminal.WithHistoryMaxAge(24 * time.Hour),           // 1天
)
```

**估算**: 10个会话 × 1MB × 1条 = 10MB

---

### 场景 2: 平衡配置 (生产环境)

```go
manager := terminal.NewManager(
    db,
    os.Getenv("SHELL"),
    terminal.WithHistoryBufferSize(5 * 1024 * 1024),      // 5MB
    terminal.WithHistoryFlushInterval(10 * time.Second),  // 10秒
    terminal.WithHistoryMaxRecords(5),                    // 保留 5 条
    terminal.WithHistoryMaxAge(7 * 24 * time.Hour),       // 7天
)
```

**估算**: 10个会话 × 5MB × 5条 = 250MB

---

### 场景 3: 完整历史 (调试/审计)

```go
manager := terminal.NewManager(
    db,
    os.Getenv("SHELL"),
    terminal.WithHistoryBufferSize(10 * 1024 * 1024),     // 10MB
    terminal.WithHistoryFlushInterval(5 * time.Second),   // 5秒
    terminal.WithHistoryMaxRecords(100),                  // 保留 100 条
    terminal.WithHistoryMaxAge(30 * 24 * time.Hour),      // 30天
)
```

**估算**: 10个会话 × 10MB × 100条 = 10GB

---

### 场景 4: 禁用持久化 (纯内存)

```go
manager := terminal.NewManager(
    db,
    os.Getenv("SHELL"),
    terminal.WithHistoryBufferSize(10 * 1024 * 1024),     // 10MB 内存
    terminal.WithHistoryMaxRecords(0),                    // 不持久化
)
```

**说明**: `historyMaxRecords = 0` 时跳过数据库写入,仅使用内存缓冲区。

---

## 定期清理任务

在应用启动时添加定期清理:

```go
manager := terminal.NewManager(db, os.Getenv("SHELL"))

// 每天凌晨 2 点清理过期历史
go func() {
    ticker := time.NewTicker(24 * time.Hour)
    defer ticker.Stop()

    for range ticker.C {
        if err := manager.CleanupExpiredHistory(); err != nil {
            log.Printf("cleanup history failed: %v", err)
        }
    }
}()
```

---

## 监控建议

### 数据库大小监控

```sql
-- 查看历史表大小
SELECT
    COUNT(*) as record_count,
    SUM(LENGTH(data)) / 1024 / 1024 as size_mb
FROM terminal_history;

-- 按会话统计
SELECT
    session_id,
    COUNT(*) as record_count,
    SUM(LENGTH(data)) / 1024 / 1024 as size_mb,
    MAX(created_at) as last_update
FROM terminal_history
GROUP BY session_id
ORDER BY size_mb DESC;
```

### 清理旧会话

```sql
-- 删除已关闭且超过 30 天的会话历史
DELETE FROM terminal_history
WHERE session_id IN (
    SELECT id FROM terminal_sessions
    WHERE status = 'closed'
    AND updated_at < strftime('%s', 'now', '-30 days')
);
```

---

## 性能优化建议

1. **索引优化**:
```sql
CREATE INDEX idx_history_session_created ON terminal_history(session_id, created_at);
CREATE INDEX idx_history_created ON terminal_history(created_at);
```

2. **定期 VACUUM** (SQLite):
```sql
VACUUM;
```

3. **WAL 模式** (SQLite):
```go
db.Exec("PRAGMA journal_mode=WAL;")
```

4. **批量删除优化**:
```go
// 分批删除避免锁表
func (m *Manager) pruneOldHistoryRecords(sessionID string) error {
    batchSize := 100
    for {
        result := m.db.Where("session_id = ?", sessionID).
            Order("created_at ASC").
            Limit(batchSize).
            Delete(&TerminalHistory{})

        if result.RowsAffected == 0 {
            break
        }
    }
    return nil
}
```

---

## 常见问题

### Q: 为什么每次都保存完整的 10MB 缓冲区?

A: 当前设计简化了实现。优化方案:
- 使用增量快照 (只保存变化部分)
- 压缩存储 (gzip)
- 分段存储 (多个小块)

### Q: 如何彻底禁用历史功能?

A: 设置 `historyMaxRecords = 0`,跳过所有数据库写入。

### Q: 多久清理一次数据库?

A: 推荐每天清理一次过期记录,每周执行一次 VACUUM。

### Q: 重连时加载所有历史吗?

A: 不会,只加载最新一条记录 (最后一个快照)。
