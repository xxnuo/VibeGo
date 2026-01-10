package kv

import (
	"encoding/json"

	"gorm.io/gorm"
)

type KV struct {
	K string `gorm:"column:k;primaryKey"`
	V string `gorm:"column:v"`
}

type Store struct {
	db *gorm.DB
}

func New(db *gorm.DB) (*Store, error) {
	s := &Store{db: db}
	return s, nil
}

func (s *Store) Set(key, value string) error {
	return s.db.Save(&KV{K: key, V: value}).Error
}

func (s *Store) Get(key string) (string, error) {
	var kv KV
	if err := s.db.First(&kv, "k = ?", key).Error; err != nil {
		return "", err
	}
	return kv.V, nil
}

func (s *Store) Delete(key string) error {
	return s.db.Delete(&KV{}, "k = ?", key).Error
}

func (s *Store) Exists(key string) bool {
	var count int64
	s.db.Model(&KV{}).Where("k = ?", key).Count(&count)
	return count > 0
}

func (s *Store) Keys() ([]string, error) {
	var kvs []KV
	if err := s.db.Select("k").Find(&kvs).Error; err != nil {
		return nil, err
	}
	keys := make([]string, len(kvs))
	for i, kv := range kvs {
		keys[i] = kv.K
	}
	return keys, nil
}

func (s *Store) All() (map[string]string, error) {
	var kvs []KV
	if err := s.db.Find(&kvs).Error; err != nil {
		return nil, err
	}
	result := make(map[string]string, len(kvs))
	for _, kv := range kvs {
		result[kv.K] = kv.V
	}
	return result, nil
}

func (s *Store) Clear() error {
	return s.db.Where("1 = 1").Delete(&KV{}).Error
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
