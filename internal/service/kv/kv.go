package kv

import (
	"encoding/json"

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
	kv := model.KV{Key: key, Value: value, UserID: s.userID}
	return s.db.Save(&kv).Error
}

func (s *Store) Get(key string) (string, error) {
	var kv model.KV
	query := s.db.Where("key = ?", key)
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	if err := query.First(&kv).Error; err != nil {
		return "", err
	}
	return kv.Value, nil
}

func (s *Store) Delete(key string) error {
	query := s.db.Where("key = ?", key)
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	return query.Delete(&model.KV{}).Error
}

func (s *Store) Exists(key string) bool {
	var count int64
	query := s.db.Model(&model.KV{}).Where("key = ?", key)
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	query.Count(&count)
	return count > 0
}

func (s *Store) Keys() ([]string, error) {
	var kvs []model.KV
	query := s.db.Select("key")
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	if err := query.Find(&kvs).Error; err != nil {
		return nil, err
	}
	keys := make([]string, len(kvs))
	for i, kv := range kvs {
		keys[i] = kv.Key
	}
	return keys, nil
}

func (s *Store) All() (map[string]string, error) {
	var kvs []model.KV
	query := s.db
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	if err := query.Find(&kvs).Error; err != nil {
		return nil, err
	}
	result := make(map[string]string, len(kvs))
	for _, kv := range kvs {
		result[kv.Key] = kv.Value
	}
	return result, nil
}

func (s *Store) Clear() error {
	query := s.db.Where("1 = 1")
	if s.userID != "" {
		query = query.Where("user_id = ?", s.userID)
	}
	return query.Delete(&model.KV{}).Error
}

func (s *Store) SetJSON(key string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.Set(key, string(data))
}

func (s *Store) GetJSON(key string, dest any) error {
	val, err := s.Get(key)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(val), dest)
}
