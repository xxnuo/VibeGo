# VibeGo File Manager API Examples

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/file/new | Create file or directory |
| GET | /api/file/read | Read file content |
| POST | /api/file/write | Write file content |
| GET | /api/file/list | List directory contents |
| GET | /api/file/tree | Get directory tree |
| GET | /api/file/search | Search files by pattern |
| GET | /api/file/grep | Search file contents |
| DELETE | /api/file | Remove file or directory |
| POST | /api/file/del | Remove file or directory |
| POST | /api/file/batch/del | Batch delete files |
| POST | /api/file/rename | Rename file or directory |
| POST | /api/file/mkdir | Create directory |
| GET | /api/file/abs | Get absolute path |
| POST | /api/file/move | Move files |
| POST | /api/file/copy | Copy files |
| GET | /api/file/download | Download file |
| POST | /api/file/upload | Upload file |
| POST | /api/file/compress | Compress files (zip, tar.gz) |
| POST | /api/file/decompress | Decompress files |
| GET | /api/file/size | Get file/directory size |
| POST | /api/file/check | Check if file exists |
| POST | /api/file/chmod | Change file mode |
| POST | /api/file/chown | Change file owner |
| GET | /api/file/info | Get detailed file info |

## Run Examples

```bash
# Set token (optional, defaults to "test-token")
export VIBEGO_TOKEN="your-token"

# Start VibeGo server first
cd /path/to/VibeGo && go run main.go

# Run examples
go run main.go
```

## Request Examples

### Create File
```json
POST /api/file/new
{
    "path": "/tmp/test.txt",
    "content": "Hello World",
    "is_dir": false
}
```

### Copy Files
```json
POST /api/file/copy
{
    "src_paths": ["/tmp/file1.txt", "/tmp/file2.txt"],
    "dst_path": "/tmp/backup",
    "cover": false
}
```

### Compress Files
```json
POST /api/file/compress
{
    "files": ["/tmp/file1.txt", "/tmp/dir"],
    "dst": "/tmp",
    "name": "archive.zip",
    "type": "zip"
}
```

### Change Mode
```json
POST /api/file/chmod
{
    "path": "/tmp/file.txt",
    "mode": "0755",
    "sub": false
}
```
