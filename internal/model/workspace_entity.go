package model

// Entity IDs are scoped to a workspace; built-in tool IDs are reused across sessions.
type Workspace struct {
	ID           string `gorm:"primaryKey" json:"id"`
	UserID       string `gorm:"index" json:"user_id"`
	Name         string `json:"name"`
	Position     int64  `json:"position"`
	Revision     int64  `json:"revision"`
	Data         string `gorm:"type:text" json:"data"`
	LastActiveAt int64  `json:"last_active_at"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
}

type WorkspaceFolder struct {
	WorkspaceID string `gorm:"primaryKey" json:"workspace_id"`
	ID          string `gorm:"primaryKey" json:"id"`
	Path        string `json:"path"`
	Name        string `json:"name"`
	Position    int64  `json:"position"`
	Data        string `gorm:"type:text" json:"data"`
	CreatedAt   int64  `json:"created_at"`
}

type WorkspaceTool struct {
	WorkspaceID string `gorm:"primaryKey" json:"workspace_id"`
	ID          string `gorm:"primaryKey" json:"id"`
	PageID      string `json:"page_id"`
	Name        string `json:"name"`
	Position    int64  `json:"position"`
	Data        string `gorm:"type:text" json:"data"`
	CreatedAt   int64  `json:"created_at"`
}

type WorkspaceTab struct {
	WorkspaceID string `gorm:"primaryKey" json:"workspace_id"`
	FolderID    string `gorm:"primaryKey" json:"folder_id"`
	ID          string `gorm:"primaryKey" json:"id"`
	PageID      string `gorm:"primaryKey" json:"page_id"`
	TabType     string `json:"tab_type"`
	FilePath    string `json:"file_path"`
	Title       string `json:"title"`
	Icon        string `json:"icon"`
	Closable    *bool  `json:"closable,omitempty"`
	Pinned      bool   `json:"pinned"`
	Position    int64  `json:"position"`
	Data        string `gorm:"type:text" json:"data"`
	CreatedAt   int64  `json:"created_at"`
}

type WorkspaceMutation struct {
	WorkspaceID string `gorm:"primaryKey;uniqueIndex:workspace_revision"`
	ID          string `gorm:"primaryKey"`
	Revision    int64  `gorm:"uniqueIndex:workspace_revision"`
	Mutation    string `gorm:"type:text"`
	Request     string `gorm:"type:text"`
}

type WorkspacePluginStorage struct {
	WorkspaceID string `gorm:"primaryKey" json:"workspace_id"`
	PluginID    string `gorm:"primaryKey" json:"plugin_id"`
	Scope       string `gorm:"primaryKey" json:"scope"`
	Key         string `gorm:"primaryKey" json:"key"`
	Value       string `gorm:"type:text" json:"value"`
}
