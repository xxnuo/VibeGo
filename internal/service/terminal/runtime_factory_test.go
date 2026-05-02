package terminal

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxnuo/vibego/internal/model"
	"gorm.io/gorm"
)

type rollbackTestRuntime struct {
	closed atomic.Bool
}

func (r *rollbackTestRuntime) Type() string                       { return RuntimeTypeSSH }
func (r *rollbackTestRuntime) Capabilities() TerminalCapabilities { return TerminalCapabilities{} }
func (r *rollbackTestRuntime) Read([]byte) (int, error)           { return 0, io.EOF }
func (r *rollbackTestRuntime) Write(data []byte) (int, error)     { return len(data), nil }
func (r *rollbackTestRuntime) Resize(int, int) error              { return nil }
func (r *rollbackTestRuntime) Close() error                       { r.closed.Store(true); return nil }
func (r *rollbackTestRuntime) ExitCode() int                      { return 0 }
func (r *rollbackTestRuntime) Wait(context.Context) error         { return nil }

type rollbackTestRuntimeFactory struct {
	runtime *rollbackTestRuntime
}

func (f rollbackTestRuntimeFactory) CreateRuntime(context.Context, RuntimeCreateRequest) (TerminalRuntime, error) {
	return f.runtime, nil
}

func TestManagerClosesRemoteRuntimeWhenSessionInsertFails(t *testing.T) {
	db := setupTestDB(t)
	runtime := &rollbackTestRuntime{}
	manager := NewManager(db, &ManagerConfig{
		Shell:          "/bin/sh",
		RuntimeFactory: rollbackTestRuntimeFactory{runtime: runtime},
	})

	const callbackName = "test:remote_terminal_create_failure"
	if err := db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Table == (model.TerminalSession{}).TableName() {
			tx.AddError(errors.New("forced terminal insert failure"))
		}
	}); err != nil {
		t.Fatalf("register create callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Create().Remove(callbackName) })

	_, err := manager.Create(CreateOptions{
		RuntimeType:  RuntimeTypeSSH,
		SSHProfileID: "profile-1",
	})
	if err == nil || err.Error() != "forced terminal insert failure" {
		t.Fatalf("Create() error = %v", err)
	}
	if !runtime.closed.Load() {
		t.Fatal("remote runtime was not closed after terminal insert failure")
	}
	var count int64
	if err := db.Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
		t.Fatalf("count terminal sessions: %v", err)
	}
	if count != 0 {
		t.Fatalf("terminal session count = %d, want 0", count)
	}
}

type blockingRuntimeFactory struct {
	entered chan struct{}
	release chan struct{}
	runtime *rollbackTestRuntime
}

func (f blockingRuntimeFactory) CreateRuntime(context.Context, RuntimeCreateRequest) (TerminalRuntime, error) {
	close(f.entered)
	<-f.release
	return f.runtime, nil
}

func TestRemoteRuntimeHandshakeDoesNotBlockWorkspaceDelete(t *testing.T) {
	db := setupTestDB(t)
	if err := db.Create(&model.UserSession{ID: "workspace-1", Name: "Workspace", State: "{}"}).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	runtime := &rollbackTestRuntime{}
	entered := make(chan struct{})
	release := make(chan struct{})
	manager := NewManager(db, &ManagerConfig{
		Shell: "/bin/sh",
		RuntimeFactory: blockingRuntimeFactory{
			entered: entered,
			release: release,
			runtime: runtime,
		},
	})

	createDone := make(chan error, 1)
	go func() {
		_, err := manager.CreateInWorkspace(CreateOptions{
			WorkspaceSessionID: "workspace-1",
			RuntimeType:        RuntimeTypeSSH,
			SSHProfileID:       "profile-1",
		})
		createDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("remote runtime factory was not entered")
	}

	deleteDone := make(chan error, 1)
	go func() {
		deleteDone <- manager.DeleteWorkspace("workspace-1")
	}()
	select {
	case err := <-deleteDone:
		if err != nil {
			t.Fatalf("delete workspace: %v", err)
		}
	case <-time.After(time.Second):
		close(release)
		t.Fatal("workspace delete was blocked by remote runtime creation")
	}
	close(release)

	err := <-createDone
	if !errors.Is(err, ErrWorkspaceNotFound) {
		t.Fatalf("CreateInWorkspace() error = %v, want ErrWorkspaceNotFound", err)
	}
	if !runtime.closed.Load() {
		t.Fatal("remote runtime was not closed after scope revalidation failed")
	}
	var count int64
	if err := db.Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
		t.Fatalf("count terminal sessions: %v", err)
	}
	if count != 0 {
		t.Fatalf("terminal session count = %d, want 0", count)
	}
}

func TestRemoteRuntimeIsNotPersistedAfterRequestCancellation(t *testing.T) {
	db := setupTestDB(t)
	runtime := &rollbackTestRuntime{}
	entered := make(chan struct{})
	release := make(chan struct{})
	manager := NewManager(db, &ManagerConfig{
		Shell: "/bin/sh",
		RuntimeFactory: blockingRuntimeFactory{
			entered: entered,
			release: release,
			runtime: runtime,
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	createDone := make(chan error, 1)
	go func() {
		_, err := manager.Create(CreateOptions{
			RuntimeType:  RuntimeTypeSSH,
			SSHProfileID: "profile-1",
			Context:      ctx,
		})
		createDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("remote runtime factory was not entered")
	}
	cancel()
	close(release)

	if err := <-createDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("Create() error = %v, want context.Canceled", err)
	}
	if !runtime.closed.Load() {
		t.Fatal("remote runtime was not closed after request cancellation")
	}
	var count int64
	if err := db.Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
		t.Fatalf("count terminal sessions: %v", err)
	}
	if count != 0 {
		t.Fatalf("terminal session count = %d, want 0", count)
	}
}

func TestRemoteRuntimeInsertUsesRequestContext(t *testing.T) {
	db := setupTestDB(t)
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get sql database: %v", err)
	}
	keeper, err := sqlDB.Conn(context.Background())
	if err != nil {
		t.Fatalf("keep in-memory database open: %v", err)
	}
	t.Cleanup(func() { _ = keeper.Close() })
	runtime := &rollbackTestRuntime{}
	manager := NewManager(db, &ManagerConfig{
		Shell:          "/bin/sh",
		RuntimeFactory: rollbackTestRuntimeFactory{runtime: runtime},
	})
	insertEntered := make(chan struct{})
	releaseInsert := make(chan struct{})
	const callbackName = "test:remote_terminal_context_insert_gate"
	if err := db.Callback().Create().Before("gorm:create").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Schema == nil || tx.Statement.Schema.Table != (model.TerminalSession{}).TableName() {
			return
		}
		close(insertEntered)
		<-releaseInsert
	}); err != nil {
		t.Fatalf("register create callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Create().Remove(callbackName) })

	ctx, cancel := context.WithCancel(context.Background())
	createDone := make(chan error, 1)
	go func() {
		_, err := manager.Create(CreateOptions{
			RuntimeType:  RuntimeTypeSSH,
			SSHProfileID: "profile-1",
			Context:      ctx,
		})
		createDone <- err
	}()
	select {
	case <-insertEntered:
	case <-time.After(time.Second):
		close(releaseInsert)
		t.Fatal("remote terminal insert did not enter the database callback")
	}
	cancel()
	close(releaseInsert)

	if err := <-createDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("Create() error = %v, want context.Canceled", err)
	}
	if !runtime.closed.Load() {
		t.Fatal("remote runtime was not closed after the insert context was canceled")
	}
	var count int64
	if err := db.Model(&model.TerminalSession{}).Count(&count).Error; err != nil {
		t.Fatalf("count terminal sessions: %v", err)
	}
	if count != 0 {
		t.Fatalf("terminal session count = %d, want 0", count)
	}
}

func TestRemoteRuntimeValidationUsesRequestContext(t *testing.T) {
	db := setupTestDB(t)
	if err := db.Create(&model.UserSession{ID: "workspace-1", Name: "Workspace", State: "{}"}).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	runtime := &rollbackTestRuntime{}
	manager := NewManager(db, &ManagerConfig{
		Shell:          "/bin/sh",
		RuntimeFactory: rollbackTestRuntimeFactory{runtime: runtime},
	})
	ctx := context.WithValue(context.Background(), struct{}{}, "validation-context")
	var sawContext atomic.Bool
	const callbackName = "test:remote_terminal_validation_context"
	if err := db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table == (model.UserSession{}).TableName() && tx.Statement.Context == ctx {
			sawContext.Store(true)
		}
	}); err != nil {
		t.Fatalf("register query callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Query().Remove(callbackName) })

	info, err := manager.Create(CreateOptions{
		Name:               "remote",
		WorkspaceSessionID: "workspace-1",
		RuntimeType:        RuntimeTypeSSH,
		SSHProfileID:       "profile-1",
		Context:            ctx,
	})
	if err != nil {
		t.Fatalf("Create() failed: %v", err)
	}
	if !sawContext.Load() {
		t.Fatal("workspace validation did not use the request context")
	}
	if err := manager.Close(info.ID); err != nil {
		t.Fatalf("close terminal: %v", err)
	}
}

func TestRemoteRuntimeDefaultNameCountUsesContextAndReturnsErrors(t *testing.T) {
	db := setupTestDB(t)
	runtime := &rollbackTestRuntime{}
	manager := NewManager(db, &ManagerConfig{
		Shell:          "/bin/sh",
		RuntimeFactory: rollbackTestRuntimeFactory{runtime: runtime},
	})
	ctx := context.WithValue(context.Background(), struct{}{}, "count-context")
	forcedErr := errors.New("forced terminal count failure")
	var sawContext atomic.Bool
	const callbackName = "test:remote_terminal_count_context"
	if err := db.Callback().Query().Before("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		if tx.Statement.Table != (model.TerminalSession{}).TableName() {
			return
		}
		if _, ok := tx.Statement.Dest.(*int64); !ok {
			return
		}
		if tx.Statement.Context == ctx {
			sawContext.Store(true)
		}
		tx.AddError(forcedErr)
	}); err != nil {
		t.Fatalf("register query callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Query().Remove(callbackName) })

	_, err := manager.Create(CreateOptions{
		RuntimeType:  RuntimeTypeSSH,
		SSHProfileID: "profile-1",
		Context:      ctx,
	})
	if !errors.Is(err, forcedErr) {
		t.Fatalf("Create() error = %v, want %v", err, forcedErr)
	}
	if !sawContext.Load() {
		t.Fatal("terminal count did not use the request context")
	}
	if !runtime.closed.Load() {
		t.Fatal("remote runtime was not closed after terminal count failure")
	}
}
