package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
	"github.com/xxnuo/vibego/internal/model"
	"github.com/xxnuo/vibego/internal/service/blocktermhistory"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var GlobalDB *gorm.DB = nil

func GetDB(models ...any) *gorm.DB {
	if GlobalDB != nil {
		return GlobalDB
	}

	cfg := GetConfig()
	dbPath := filepath.Join(cfg.ConfigDir, "vibego.sqlite")
	if err := os.MkdirAll(cfg.ConfigDir, 0755); err != nil {
		panic(err)
	}

	var err error
	GlobalDB, err = gorm.Open(sqlite.Open(dbPath+"?_journal_mode=WAL&_busy_timeout=5000"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		panic(err)
	}

	sqlDB, err := GlobalDB.DB()
	if err != nil {
		panic(err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	if len(models) > 0 {
		if err := GlobalDB.AutoMigrate(models...); err != nil {
			panic(err)
		}
	}

	return GlobalDB
}

var blockTermTables = []string{
	"blockterm_blocks",
	"blockterm_command_history",
	"blockterm_bookmarks",
	"blockterm_output_segments",
}

func validateBlockTermPrimaryKeys(tx *gorm.DB) error {
	for _, table := range blockTermTables {
		if !tx.Migrator().HasTable(table) {
			continue
		}

		var count int64
		if err := tx.Table(table).Where("id IS NULL").Count(&count).Error; err != nil {
			return fmt.Errorf("inspect %s primary keys: %w", table, err)
		}
		if count > 0 {
			return fmt.Errorf("%s contains %d row(s) with NULL id", table, count)
		}
	}
	return nil
}

func prepareBlockTermKinds(tx *gorm.DB) (bool, error) {
	if !tx.Migrator().HasTable(&model.BlockTermBlock{}) {
		return false, nil
	}
	if !tx.Migrator().HasColumn(&model.BlockTermBlock{}, "kind") {
		return true, nil
	}

	if !tx.Migrator().HasColumn(&model.BlockTermBlock{}, "renderer") {
		return false, tx.Exec(`
			UPDATE blockterm_blocks
			SET kind = 'command'
			WHERE kind IS NULL OR kind = ''
		`).Error
	}

	return false, tx.Exec(`
		UPDATE blockterm_blocks
		SET kind = CASE
			WHEN COALESCE(renderer, '') <> '' THEN 'renderer'
			ELSE 'command'
		END
		WHERE kind IS NULL OR kind = ''
	`).Error
}

func installBlockTermPrimaryKeyGuards(tx *gorm.DB) error {
	for _, table := range blockTermTables {
		if !tx.Migrator().HasTable(table) {
			continue
		}
		if err := tx.Exec(fmt.Sprintf(`
			CREATE TRIGGER IF NOT EXISTS %s_id_not_null_insert
			BEFORE INSERT ON %s
			WHEN NEW.id IS NULL
			BEGIN
				SELECT RAISE(ABORT, '%s id must not be null');
			END
		`, table, table, table)).Error; err != nil {
			return fmt.Errorf("guard %s inserts: %w", table, err)
		}
		if err := tx.Exec(fmt.Sprintf(`
			CREATE TRIGGER IF NOT EXISTS %s_id_not_null_update
			BEFORE UPDATE OF id ON %s
			WHEN NEW.id IS NULL
			BEGIN
				SELECT RAISE(ABORT, '%s id must not be null');
			END
		`, table, table, table)).Error; err != nil {
			return fmt.Errorf("guard %s updates: %w", table, err)
		}
	}
	return nil
}

// ensureBlockTermViewColumn upgrades an already-existing terminal_sessions
// table without creating that table as a side effect. MigrateBlockTerm is also
// used directly by upgrade/tests, where the general GetDB AutoMigrate pass may
// not have run first.
func ensureBlockTermViewColumn(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.TerminalSession{}) {
		return nil
	}
	if tx.Migrator().HasColumn(&model.TerminalSession{}, "blockterm_view_json") {
		return nil
	}
	if err := tx.Migrator().AddColumn(&model.TerminalSession{}, "BlockTermViewJSON"); err != nil {
		return fmt.Errorf("add terminal_sessions.blockterm_view_json: %w", err)
	}
	return nil
}

func ensureWorkspaceSettingsColumns(tx *gorm.DB) error {
	if tx.Migrator().HasTable(&model.UserSession{}) && !tx.Migrator().HasColumn(&model.UserSession{}, "position") {
		if err := tx.Migrator().AddColumn(&model.UserSession{}, "Position"); err != nil {
			return fmt.Errorf("add user_sessions.position: %w", err)
		}
	}
	if !tx.Migrator().HasTable(&model.TerminalSession{}) {
		return nil
	}
	if !tx.Migrator().HasColumn(&model.TerminalSession{}, "tab_color") {
		if err := tx.Migrator().AddColumn(&model.TerminalSession{}, "TabColor"); err != nil {
			return fmt.Errorf("add terminal_sessions.tab_color: %w", err)
		}
	}
	if !tx.Migrator().HasColumn(&model.TerminalSession{}, "tab_icon") {
		if err := tx.Migrator().AddColumn(&model.TerminalSession{}, "TabIcon"); err != nil {
			return fmt.Errorf("add terminal_sessions.tab_icon: %w", err)
		}
	}
	return nil
}

func normalizeUserSessionPositions(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.UserSession{}) || !tx.Migrator().HasColumn(&model.UserSession{}, "position") {
		return nil
	}

	type sessionPosition struct {
		ID       string `gorm:"column:id"`
		Position int64  `gorm:"column:position"`
	}
	var sessions []sessionPosition
	if err := tx.Table((model.UserSession{}).TableName()).
		Select("id", "position").
		Order("CASE WHEN position > 0 THEN 0 ELSE 1 END ASC").
		Order("CASE WHEN position > 0 THEN position ELSE 0 END ASC").
		Order("updated_at DESC").
		Order("id ASC").
		Find(&sessions).Error; err != nil {
		return fmt.Errorf("load user session positions: %w", err)
	}
	for i, session := range sessions {
		position := int64(i + 1)
		if session.Position == position {
			continue
		}
		if err := tx.Table((model.UserSession{}).TableName()).
			Where("id = ?", session.ID).
			UpdateColumn("position", position).Error; err != nil {
			return fmt.Errorf("update user session %s position: %w", session.ID, err)
		}
	}
	return nil
}

// MigrateBlockTerm upgrades BlockTerm tables in an order that preserves legacy
// rows before enforcing current constraints, then backfills command history.
func MigrateBlockTerm(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if err := validateBlockTermPrimaryKeys(tx); err != nil {
			return err
		}
		if err := ensureBlockTermViewColumn(tx); err != nil {
			return err
		}
		if err := ensureWorkspaceSettingsColumns(tx); err != nil {
			return err
		}
		if err := normalizeUserSessionPositions(tx); err != nil {
			return err
		}
		legacyKindsNeedClassification, err := prepareBlockTermKinds(tx)
		if err != nil {
			return err
		}
		historyStarredNeedsBackfill := tx.Migrator().HasTable(&model.BlockTermCommandHistory{}) &&
			!tx.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "starred")
		historyRuntimeColumnWasMissing := tx.Migrator().HasTable(&model.BlockTermCommandHistory{}) &&
			!tx.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "runtime_type")
		historySSHProfileColumnWasMissing := tx.Migrator().HasTable(&model.BlockTermCommandHistory{}) &&
			!tx.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "ssh_profile_id")
		if err := tx.AutoMigrate(
			&model.BlockTermBlock{},
			&model.BlockTermCommandHistory{},
			&model.BlockTermBookmark{},
			&model.BlockTermOutputSegment{},
		); err != nil {
			return err
		}
		if err := installBlockTermPrimaryKeyGuards(tx); err != nil {
			return err
		}
		if err := tx.Exec(`
			UPDATE blockterm_blocks
			SET kind = CASE
				WHEN COALESCE(renderer, '') <> '' THEN 'renderer'
				ELSE 'command'
			END
			WHERE kind IS NULL OR kind = ''
		`).Error; err != nil {
			return err
		}
		// AutoMigrate assigns the command default when adding kind to a legacy
		// table. Only those rows need renderer-based classification. Existing
		// command rows may legitimately carry a renderer selected by the user.
		if legacyKindsNeedClassification {
			if err := tx.Exec(`
				UPDATE blockterm_blocks
				SET kind = 'renderer'
				WHERE kind = 'command' AND COALESCE(renderer, '') <> ''
			`).Error; err != nil {
				return err
			}
		}
		if err := backfillBlockTermRuntimeSelections(tx); err != nil {
			return err
		}
		if historyStarredNeedsBackfill && tx.Migrator().HasTable(&model.BlockTermBlock{}) {
			if err := tx.Exec(`
				UPDATE blockterm_command_history
				SET starred = COALESCE((
					SELECT blocks.starred
					FROM blockterm_blocks AS blocks
					WHERE blocks.id = blockterm_command_history.id
					  AND blocks.created_at = blockterm_command_history.created_at
					  AND COALESCE(blocks.kind, 'command') <> 'note'
					  AND NOT (
						COALESCE(blocks.renderer, '') = 'openai'
						AND CASE
							WHEN json_valid(COALESCE(blocks.state_json, '')) THEN
								json_type(blocks.state_json, '$.source_block_id') = 'text'
								AND COALESCE(json_extract(blocks.state_json, '$.source_block_id'), '') <> ''
							ELSE 0
						END
					  )
				), 0)
				WHERE EXISTS (
					SELECT 1
					FROM blockterm_blocks AS blocks
					WHERE blocks.id = blockterm_command_history.id
					  AND blocks.created_at = blockterm_command_history.created_at
					  AND COALESCE(blocks.kind, 'command') <> 'note'
					  AND NOT (
						COALESCE(blocks.renderer, '') = 'openai'
						AND CASE
							WHEN json_valid(COALESCE(blocks.state_json, '')) THEN
								json_type(blocks.state_json, '$.source_block_id') = 'text'
								AND COALESCE(json_extract(blocks.state_json, '$.source_block_id'), '') <> ''
							ELSE 0
						END
					  )
				)
			`).Error; err != nil {
				return err
			}
		}
		if err := backfillBlockTermHistoryRuntimeSelections(
			tx,
			historyRuntimeColumnWasMissing,
			historySSHProfileColumnWasMissing,
		); err != nil {
			return err
		}
		if !tx.Migrator().HasTable(&model.BlockTermBlock{}) ||
			!tx.Migrator().HasTable(&model.TerminalSession{}) {
			return nil
		}

		insertColumns := `
			id,
			terminal_id,
			workspace_session_id,
			group_id,
			user_id,
			runtime_type,
			ssh_profile_id`
		profileSelect := "COALESCE(blocks.ssh_profile_id, '')"
		hasTerminalSSHProfile := tx.Migrator().HasColumn(&model.TerminalSession{}, "ssh_profile_id")
		if historySSHProfileColumnWasMissing && hasTerminalSSHProfile {
			// Rows inserted while upgrading the legacy history schema keep the
			// terminal profile fallback used by that schema. Current blocks carry
			// an explicit per-block profile and do not use this compatibility path.
			profileSelect = "COALESCE(NULLIF(TRIM(blocks.ssh_profile_id), ''), terminals.ssh_profile_id, '')"
		}
		selectColumns := `
			blocks.id,
			blocks.terminal_id,
			COALESCE(terminals.workspace_session_id, ''),
			COALESCE(terminals.group_id, ''),
			COALESCE(terminals.user_id, ''),
			COALESCE(NULLIF(TRIM(blocks.runtime_type), ''), NULLIF(TRIM(terminals.runtime_type), ''), 'local'),
			` + profileSelect
		insertColumns += `,
			line_num,
			command,
			cwd,
			starred,
			created_at`
		selectColumns += `,
			blocks.line_num,
			COALESCE(blocks.command, ''),
			blocks.cwd,
			blocks.starred,
			blocks.created_at`
		if err := tx.Exec(`
			INSERT INTO blockterm_command_history (` + insertColumns + `
			)
			SELECT` + selectColumns + `
			FROM blockterm_blocks AS blocks
			LEFT JOIN terminal_sessions AS terminals ON terminals.id = blocks.terminal_id
				WHERE COALESCE(blocks.kind, 'command') <> 'note'
					AND NOT (
						COALESCE(blocks.renderer, '') = 'openai'
						AND CASE
							WHEN json_valid(COALESCE(blocks.state_json, '')) THEN
								json_type(blocks.state_json, '$.source_block_id') = 'text'
								AND COALESCE(json_extract(blocks.state_json, '$.source_block_id'), '') <> ''
							ELSE 0
						END
					)
			ON CONFLICT(id) DO NOTHING
		`).Error; err != nil {
			return err
		}
		return blocktermhistory.SyncAllForMigration(tx)
	})
}

func backfillBlockTermRuntimeSelections(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.BlockTermBlock{}) {
		return nil
	}

	runtimeSelect := "'local'"
	if tx.Migrator().HasTable(&model.TerminalSession{}) &&
		tx.Migrator().HasColumn(&model.TerminalSession{}, "runtime_type") {
		runtimeSelect = `CASE
			WHEN LOWER(TRIM(COALESCE((
				SELECT terminals.runtime_type
				FROM terminal_sessions AS terminals
				WHERE terminals.id = blockterm_blocks.terminal_id
				LIMIT 1
			), ''))) = 'ssh' THEN 'ssh'
			ELSE 'local'
		END`
	}
	if err := tx.Exec(`
		UPDATE blockterm_blocks
		SET runtime_type = ` + runtimeSelect + `
		WHERE COALESCE(TRIM(runtime_type), '') = ''
	`).Error; err != nil {
		return err
	}

	if !tx.Migrator().HasTable(&model.TerminalSession{}) ||
		!tx.Migrator().HasColumn(&model.TerminalSession{}, "ssh_profile_id") {
		return nil
	}
	return tx.Exec(`
		UPDATE blockterm_blocks
		SET ssh_profile_id = COALESCE((
			SELECT terminals.ssh_profile_id
			FROM terminal_sessions AS terminals
			WHERE terminals.id = blockterm_blocks.terminal_id
			LIMIT 1
		), '')
		WHERE runtime_type = 'ssh'
		  AND COALESCE(TRIM(ssh_profile_id), '') = ''
	`).Error
}

func backfillBlockTermHistoryRuntimeSelections(
	tx *gorm.DB,
	runtimeColumnWasMissing bool,
	sshProfileColumnWasMissing bool,
) error {
	if !tx.Migrator().HasTable(&model.BlockTermCommandHistory{}) {
		return nil
	}

	hasBlocks := tx.Migrator().HasTable(&model.BlockTermBlock{})
	hasRuntime := tx.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "runtime_type")
	if tx.Migrator().HasColumn(&model.BlockTermCommandHistory{}, "ssh_profile_id") {
		profileFallback := "''"
		if tx.Migrator().HasTable(&model.TerminalSession{}) &&
			tx.Migrator().HasColumn(&model.TerminalSession{}, "ssh_profile_id") {
			profileFallback = `COALESCE((
				SELECT terminals.ssh_profile_id
				FROM terminal_sessions AS terminals
				WHERE terminals.id = blockterm_command_history.terminal_id
				LIMIT 1
			), '')`
		}
		profileSelect := profileFallback
		if hasBlocks {
			blockProfile := `COALESCE(NULLIF(TRIM((
				SELECT blocks.ssh_profile_id
				FROM blockterm_blocks AS blocks
				WHERE blocks.id = blockterm_command_history.id
				  AND blocks.terminal_id = blockterm_command_history.terminal_id
				  AND blocks.created_at = blockterm_command_history.created_at
				LIMIT 1
			)), ''), ` + profileFallback + `)`
			if runtimeColumnWasMissing || sshProfileColumnWasMissing || !hasRuntime {
				profileSelect = blockProfile
			} else {
				// A non-empty history runtime is already part of the immutable
				// execution identity. Only rows with no connection identity yet may
				// take a matching block's newer per-block profile.
				profileSelect = `CASE
					WHEN COALESCE(TRIM(blockterm_command_history.runtime_type), '') = '' THEN ` + blockProfile + `
					ELSE ` + profileFallback + `
				END`
			}
		}
		if err := tx.Exec(`
			UPDATE blockterm_command_history
			SET ssh_profile_id = ` + profileSelect + `
			WHERE history_purged_at IS NULL
			  AND COALESCE(ssh_profile_id, '') = ''
		`).Error; err != nil {
			return err
		}
	}

	if !hasRuntime {
		return nil
	}
	runtimeSelect := "'local'"
	if tx.Migrator().HasTable(&model.TerminalSession{}) &&
		tx.Migrator().HasColumn(&model.TerminalSession{}, "runtime_type") {
		runtimeSelect = `COALESCE(NULLIF(TRIM((
			SELECT terminals.runtime_type
			FROM terminal_sessions AS terminals
			WHERE terminals.id = blockterm_command_history.terminal_id
			LIMIT 1
		)), ''), 'local')`
	}
	if hasBlocks {
		runtimeSelect = `COALESCE(NULLIF(TRIM((
				SELECT blocks.runtime_type
				FROM blockterm_blocks AS blocks
				WHERE blocks.id = blockterm_command_history.id
				  AND blocks.terminal_id = blockterm_command_history.terminal_id
				  AND blocks.created_at = blockterm_command_history.created_at
			LIMIT 1
		)), ''), ` + runtimeSelect + `)`
	}
	return tx.Exec(`
		UPDATE blockterm_command_history
		SET runtime_type = ` + runtimeSelect + `
		WHERE history_purged_at IS NULL
		  AND COALESCE(TRIM(runtime_type), '') = ''
	`).Error
}
