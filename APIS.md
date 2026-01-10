# VibeGo API Documentation

This document details the API endpoints available in the VibeGo backend.

**Base URL**: `http://<host>:<port>`
**API Base URL**: `http://<host>:<port>/api`

## System Endpoints (Root)

These endpoints are available at the root level and check system status.

| Method | Endpoint          | Description            | Response Example |
| :----- | :---------------- | :--------------------- | :--------------- |
| GET    | `/version`        | Get server version     | `{"version": "0.0.1"}` |
| GET    | `/health`         | Health check           | `{"status": "ok"}` |
| GET    | `/__heartbeat__`  | Simple heartbeat       | `Ready` (text) |
| GET    | `/__lbheartbeat__`| Load balancer heartbeat| `Ready` (text) |

---

## File API `/api/file`

Operations for file system management.

### Create New File/Directory
**POST** `/api/file/new`

**Body:**
```json
{
  "path": "string (relative or absolute path)",
  "content": "string (optional, for files)",
  "is_dir": "boolean"
}
```
**Response:**
```json
{ "ok": true, "path": "/absolute/path/to/created" }
```

### Read File Content
**GET** `/api/file/read?path=...`

**Query Params:**
- `path`: File path

**Response:**
```json
{
  "path": "/absolute/path",
  "content": "file content string",
  "size": 1024
}
```

### Write File Content
**POST** `/api/file/write`

**Body:**
```json
{
  "path": "string",
  "content": "string"
}
```
**Response:**
```json
{ "ok": true, "path": "/absolute/path" }
```

### List Directory
**GET** `/api/file/list?path=...`

**Query Params:**
- `path`: Directory path (default: `.`)

**Response:**
```json
{
  "path": "/absolute/path",
  "files": [
    {
      "name": "filename",
      "path": "/absolute/path/filename",
      "is_dir": false,
      "size": 123,
      "mod_time": 1678900000
    }
  ]
}
```

### Get Directory Tree
**GET** `/api/file/tree?path=...`

**Query Params:**
- `path`: Directory path (default: `.`)

**Response:**
```json
{
  "name": "root_dir",
  "path": "/absolute/path",
  "is_dir": true,
  "children": [
    {
      "name": "child",
      "path": "...",
      "is_dir": true,
      "children": [...]
    }
  ]
}
```

### Search Files
**GET** `/api/file/search?path=...&pattern=...`

**Query Params:**
- `path`: Search root path (default: `.`)
- `pattern`: Glob pattern (e.g., `*.go`)

**Response:**
```json
{
  "matches": [
    { "name": "main.go", "path": "...", ... }
  ]
}
```

### Remove File/Directory
**DELETE** `/api/file/rm`

**Body:**
```json
{ "path": "string" }
```
**Response:**
```json
{ "ok": true }
```

### Rename/Move
**POST** `/api/file/rename`

**Body:**
```json
{
  "old_path": "string",
  "new_path": "string"
}
```
**Response:**
```json
{ "ok": true, "path": "/new/absolute/path" }
```

### Create Directory (Mkdir)
**POST** `/api/file/mkdir`

**Body:**
```json
{ "path": "string" }
```
**Response:**
```json
{ "ok": true, "path": "/absolute/path" }
```

### Get Absolute Path
**GET** `/api/file/abs?path=...`

**Query Params:**
- `path`: Relative path

**Response:**
```json
{ "path": "/absolute/path" }
```

---

## Git API `/api/git`

Operations for Git version control.

### Bind Existing Repository
**POST** `/api/git/bind`

**Body:**
```json
{
  "path": "string (local path)",
  "remotes": "string (optional)"
}
```
**Response:**
```json
{ "ok": true, "id": "uuid" }
```

### Unbind Repository
**POST** `/api/git/unbind`

**Body:**
```json
{ "id": "repo_uuid" }
```
**Response:**
```json
{ "ok": true }
```

### List Bound Repositories
**GET** `/api/git/list`

**Response:**
```json
{
  "repos": [
    {
      "id": "uuid",
      "path": "...",
      "remotes": "...",
      "created_at": 1234567890,
      "updated_at": 1234567890
    }
  ]
}
```

### Initialize New Repository
**POST** `/api/git/new`

**Body:**
```json
{ "path": "string" }
```
**Response:**
```json
{ "ok": true, "id": "uuid" }
```

### Clone Repository
**POST** `/api/git/clone`

**Body:**
```json
{
  "url": "https://github.com/user/repo.git",
  "path": "local/path"
}
```
**Response:**
```json
{ "ok": true, "id": "uuid" }
```

### Get Status
**GET** `/api/git/status?id=...`

**Query Params:**
- `id`: Repo ID

**Response:**
```json
{
  "files": [
    {
      "path": "file.txt",
      "status": "M", // M=Modified, A=Added, D=Deleted, ?=Untracked
      "staged": false
    }
  ]
}
```

### Get Commit Log
**GET** `/api/git/log?id=...&limit=...`

**Query Params:**
- `id`: Repo ID
- `limit`: Number of commits (default: 20)

**Response:**
```json
{
  "commits": [
    {
      "hash": "abc1234...",
      "message": "commit message",
      "author": "Author Name",
      "date": "RFC3339 timestamp"
    }
  ]
}
```

### Get Diff
**GET** `/api/git/diff?id=...&path=...`

**Query Params:**
- `id`: Repo ID
- `path`: File path

**Response:**
```json
{
  "path": "file.txt",
  "old": "content before",
  "new": "content after"
}
```

### Show File Content (Specific Version)
**GET** `/api/git/show?id=...&path=...&ref=...`

**Query Params:**
- `id`: Repo ID
- `path`: File path
- `ref`: Commit hash or ref (default: HEAD)

**Response:**
```json
{ "content": "file content..." }
```

### Stage Files (Add)
**POST** `/api/git/add`

**Body:**
```json
{
  "id": "repo_uuid",
  "files": ["file1.txt", "dir/file2.go"]
}
```
**Response:**
```json
{ "ok": true }
```

### Commit Changes
**POST** `/api/git/commit`

**Body:**
```json
{
  "id": "repo_uuid",
  "message": "Commit message"
}
```
**Response:**
```json
{ "ok": true, "hash": "new_commit_hash" }
```

### Unstage Files (Reset)
**POST** `/api/git/reset`

**Body:**
```json
{
  "id": "repo_uuid"
}
```
**Response:**
```json
{ "ok": true, "message": "All changes unstaged (Mixed Reset)" }
```

### Discard Changes (Checkout)
**POST** `/api/git/checkout`

**Body:**
```json
{
  "id": "repo_uuid",
  "files": ["file_to_discard.txt"]
}
```
**Response:**
```json
{ "ok": true }
```

### Undo Last Commit
**POST** `/api/git/undo_commit`

**Body:**
```json
{ "id": "repo_uuid" }
```
**Response:**
```json
{ "ok": true, "message": "Undid last commit (Soft Reset)" }
```

---

## Session API `/api/session`

Operations for chat/interaction sessions.

### List Sessions
**GET** `/api/session/list`

**Response:**
```json
{
  "sessions": [
    { "id": "uuid", "name": "Session Name", "created_at": ..., "updated_at": ... }
  ]
}
```

### Create Session
**POST** `/api/session/new`

**Body:**
```json
{ "name": "My Session" }
```
**Response:**
```json
{ "ok": true, "id": "uuid" }
```

### Save Session
**POST** `/api/session/save`

**Body:**
```json
{
  "id": "uuid",
  "name": "New Name (optional)",
  "messages": "JSON string of messages (optional)"
}
```
**Response:**
```json
{ "ok": true }
```

### Load Session
**GET** `/api/session/load?id=...`

**Query Params:**
- `id`: Session ID

**Response:**
```json
{
  "id": "uuid",
  "name": "Session Name",
  "messages": "JSON string...",
  "created_at": ...,
  "updated_at": ...
}
```

### Remove Session
**DELETE** `/api/session/rm`

**Body:**
```json
{ "id": "uuid" }
```
**Response:**
```json
{ "ok": true }
```

---

## Settings API `/api/settings`

Operations for application settings (KV store).

### List Settings
**GET** `/api/settings/list`

**Response:**
```json
{
  "key1": "value1",
  "key2": "value2"
}
```

### Set Setting
**POST** `/api/settings/set`

**Body:**
```json
{ "key": "string", "value": "string" }
```
**Response:**
```json
{ "ok": true }
```

### Get Setting
**GET** `/api/settings/get?key=...`

**Query Params:**
- `key`: Setting key

**Response:**
```json
{ "key": "...", "value": "..." }
```

### Reset Settings
**POST** `/api/settings/reset`

**Response:**
```json
{ "ok": true }
```

---

## Terminal API `/api/terminal`

Operations for managing terminal sessions.

### List Terminals
**GET** `/api/terminal/list`

**Response:**
```json
{
  "terminals": [
    {
      "id": "uuid",
      "name": "Terminal 1",
      "shell": "/bin/bash",
      "cwd": "/path/to/cwd",
      "cols": 80,
      "rows": 24,
      "status": "running",
      "pty_status": "active",
      "exit_code": 0,
      "history_size": 1024,
      "created_at": ...,
      "updated_at": ...
    }
  ]
}
```

### Create Terminal
**POST** `/api/terminal/new`

**Body:**
```json
{
  "name": "My Term",
  "cwd": "/starting/path",
  "cols": 80,
  "rows": 24
}
```
**Response:**
```json
{ "ok": true, "id": "uuid", "name": "My Term" }
```

### Close Terminal
**POST** `/api/terminal/close`

**Body:**
```json
{ "id": "uuid" }
```
**Response:**
```json
{ "ok": true }
```

### WebSocket Connection
**GET** `/api/terminal/ws/:id`

Connect to this endpoint via WebSocket to interact with the terminal.
