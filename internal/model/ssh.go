package model

type SSHConnectionProfile struct {
	ID             string `gorm:"column:id;primaryKey" json:"id"`
	Name           string `gorm:"column:name;not null" json:"name"`
	Host           string `gorm:"column:host;not null" json:"host"`
	Port           int    `gorm:"column:port;not null" json:"port"`
	User           string `gorm:"column:user;not null" json:"user"`
	AuthMethod     string `gorm:"column:auth_method;not null" json:"auth_method"`
	IdentityFile   string `gorm:"column:identity_file" json:"identity_file,omitempty"`
	ConnectTimeout int    `gorm:"column:connect_timeout;not null" json:"connect_timeout"`
	CreatedAt      int64  `gorm:"column:created_at;not null;index" json:"created_at"`
	UpdatedAt      int64  `gorm:"column:updated_at;not null;index" json:"updated_at"`
}

func (SSHConnectionProfile) TableName() string {
	return "ssh_connection_profiles"
}

type SSHKnownHost struct {
	Endpoint    string `gorm:"column:endpoint;primaryKey" json:"endpoint"`
	Host        string `gorm:"column:host;not null" json:"host"`
	Port        int    `gorm:"column:port;not null" json:"port"`
	KeyType     string `gorm:"column:key_type;not null" json:"key_type"`
	PublicKey   string `gorm:"column:public_key;type:text;not null" json:"-"`
	Fingerprint string `gorm:"column:fingerprint;not null" json:"fingerprint"`
	CreatedAt   int64  `gorm:"column:created_at;not null" json:"created_at"`
	UpdatedAt   int64  `gorm:"column:updated_at;not null" json:"updated_at"`
}

func (SSHKnownHost) TableName() string {
	return "ssh_known_hosts"
}
