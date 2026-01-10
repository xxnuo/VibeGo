package settings

import (
	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type Store struct {
	db     *gorm.DB
	userID string
}

func New(db *gorm.DB) *Store {
	return &Store{db: db}
}

func NewWithUser(db *gorm.DB, userID string) *Store {
	return &Store{db: db, userID: userID}
}

func (s *Store) Set(key, value string) error {
	setting := model.UserSetting{UserID: s.userID, Key: key, Value: value}
	return s.db.Save(&setting).Error
}

func (s *Store) Get(key string) (string, error) {
	var setting model.UserSetting
	query := s.db.Where("key = ?", key)
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	if err := query.First(&setting).Error; err != nil {
		return "", err
	}
	return setting.Value, nil
}

func (s *Store) All() (map[string]string, error) {
	var settings []model.UserSetting
	query := s.db
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	if err := query.Find(&settings).Error; err != nil {
		return nil, err
	}
	result := make(map[string]string, len(settings))
	for _, setting := range settings {
		result[setting.Key] = setting.Value
	}
	return result, nil
}

func (s *Store) Clear() error {
	query := s.db.Where("1 = 1")
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	return query.Delete(&model.UserSetting{}).Error
}
