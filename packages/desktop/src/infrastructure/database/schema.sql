-- Projects table to store multiple git repositories
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  location_type TEXT NOT NULL DEFAULT 'local' CHECK(location_type IN ('local', 'remote')),
  remote_host TEXT,
  remote_user TEXT,
  remote_port INTEGER,
  remote_path TEXT,
  remote_auth_type TEXT DEFAULT 'ssh-agent' CHECK(remote_auth_type IN ('ssh-agent', 'keyfile')),
  remote_key_path TEXT,
  system_prompt TEXT,
  run_script TEXT,
  build_script TEXT,
  active BOOLEAN NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  main_branch TEXT,
  default_permission_mode TEXT DEFAULT 'ignore' CHECK(default_permission_mode IN ('approve', 'ignore')),
  open_ide_command TEXT,
  display_order INTEGER,
  worktree_folder TEXT,
  lastUsedModel TEXT DEFAULT 'sonnet',
  commit_mode TEXT DEFAULT 'checkpoint',
  commit_structured_prompt_template TEXT,
  commit_checkpoint_prefix TEXT DEFAULT 'checkpoint: '
);

-- Folders table to organize sessions inside projects (supports nesting)
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  parent_folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  display_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Sessions table to store persistent session data
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initial_prompt TEXT NOT NULL,
  worktree_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  status_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_output TEXT,
  exit_code INTEGER,
  pid INTEGER,
  claude_session_id TEXT,
  archived BOOLEAN DEFAULT 0,
  last_viewed_at DATETIME,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  permission_mode TEXT DEFAULT 'ignore' CHECK(permission_mode IN ('approve', 'ignore')),
  run_started_at DATETIME,
  is_main_repo BOOLEAN DEFAULT 0,
  display_order INTEGER,
  is_favorite BOOLEAN DEFAULT 0,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  auto_commit BOOLEAN DEFAULT 1,
  tool_type TEXT DEFAULT 'claude',
  base_commit TEXT,
  base_branch TEXT,
  commit_mode TEXT,
  commit_mode_settings TEXT,
  skip_continue_next BOOLEAN DEFAULT 0,
  active_panel_id TEXT
);

-- Tool panels (tabs) per session (claude/codex/diff/logs/...)
CREATE TABLE IF NOT EXISTS tool_panels (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT,
  metadata TEXT,
  settings TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Session outputs table to store terminal output history
CREATE TABLE IF NOT EXISTS session_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  panel_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Conversation messages table to track conversation history
CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  panel_id TEXT,
  message_type TEXT NOT NULL CHECK (message_type IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Prompt markers for associating prompts with terminal output
CREATE TABLE IF NOT EXISTS prompt_markers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  panel_id TEXT,
  prompt_text TEXT NOT NULL,
  output_index INTEGER NOT NULL,
  output_line INTEGER,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  completion_timestamp DATETIME,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Execution diffs captured across runs and commits
CREATE TABLE IF NOT EXISTS execution_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  panel_id TEXT,
  prompt_marker_id INTEGER,
  execution_sequence INTEGER NOT NULL,
  git_diff TEXT,
  files_changed TEXT,
  stats_additions INTEGER DEFAULT 0,
  stats_deletions INTEGER DEFAULT 0,
  stats_files_changed INTEGER DEFAULT 0,
  before_commit_hash TEXT,
  after_commit_hash TEXT,
  commit_message TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (prompt_marker_id) REFERENCES prompt_markers(id) ON DELETE SET NULL
);

-- Project run commands (multiple saved commands per project)
CREATE TABLE IF NOT EXISTS project_run_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  command TEXT NOT NULL,
  display_name TEXT,
  order_index INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- UI state key/value store
CREATE TABLE IF NOT EXISTS ui_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- App opens tracking (welcome/discord gating, etc.)
CREATE TABLE IF NOT EXISTS app_opens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  welcome_hidden BOOLEAN DEFAULT 0,
  discord_shown BOOLEAN DEFAULT 0,
  app_version TEXT
);

-- User preferences key/value store
CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Default preferences and migration flags for fresh installs
INSERT OR IGNORE INTO user_preferences (key, value) VALUES
  ('hide_welcome', 'false'),
  ('hide_discord', 'false'),
  ('welcome_shown', 'false'),
  ('auto_commit_migrated', 'true'),
  ('claude_panels_migrated', 'true'),
  ('diff_panels_migrated', 'true'),
  ('unified_panel_settings_migrated', 'true'),
  ('folder_session_order_fix_applied', 'true');

-- Timeline events table (append-only audit log for Git/CLI/Chat)
-- NOTE: Intentionally no FK to sessions to allow recording events before a session row exists.
CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  timestamp DATETIME NOT NULL,
  kind TEXT NOT NULL,
  status TEXT,
  command TEXT,
  cwd TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  panel_id TEXT,
  tool TEXT,
  meta_json TEXT,
  tool_name TEXT,
  tool_input TEXT,
  tool_result TEXT,
  is_error INTEGER DEFAULT 0,
  content TEXT,
  is_streaming INTEGER DEFAULT 0,
  tool_use_id TEXT,
  questions TEXT,
  answers TEXT,
  action_type TEXT,
  thinking_id TEXT
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_projects_display_order ON projects(display_order);
CREATE INDEX IF NOT EXISTS idx_project_run_commands_project_id ON project_run_commands(project_id);

CREATE INDEX IF NOT EXISTS idx_folders_project_id ON folders(project_id);
CREATE INDEX IF NOT EXISTS idx_folders_display_order ON folders(project_id, display_order);
CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_folder_id);

CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_is_main_repo ON sessions(is_main_repo, project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_display_order ON sessions(project_id, display_order);
CREATE INDEX IF NOT EXISTS idx_sessions_folder_id ON sessions(folder_id);

CREATE INDEX IF NOT EXISTS idx_tool_panels_session_id ON tool_panels(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_panels_type ON tool_panels(type);

CREATE INDEX IF NOT EXISTS idx_session_outputs_session_id ON session_outputs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_outputs_timestamp ON session_outputs(timestamp);
CREATE INDEX IF NOT EXISTS idx_session_outputs_panel_id ON session_outputs(panel_id);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_id ON conversation_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_panel_id ON conversation_messages(panel_id);

CREATE INDEX IF NOT EXISTS idx_prompt_markers_session_id ON prompt_markers(session_id);
CREATE INDEX IF NOT EXISTS idx_prompt_markers_timestamp ON prompt_markers(timestamp);
CREATE INDEX IF NOT EXISTS idx_prompt_markers_panel_id ON prompt_markers(panel_id);

CREATE INDEX IF NOT EXISTS idx_execution_diffs_session_id ON execution_diffs(session_id);
CREATE INDEX IF NOT EXISTS idx_execution_diffs_prompt_marker_id ON execution_diffs(prompt_marker_id);
CREATE INDEX IF NOT EXISTS idx_execution_diffs_timestamp ON execution_diffs(timestamp);
CREATE INDEX IF NOT EXISTS idx_execution_diffs_sequence ON execution_diffs(session_id, execution_sequence);
CREATE INDEX IF NOT EXISTS idx_execution_diffs_panel_id ON execution_diffs(panel_id);

CREATE INDEX IF NOT EXISTS idx_ui_state_key ON ui_state(key);
CREATE INDEX IF NOT EXISTS idx_app_opens_opened_at ON app_opens(opened_at);
CREATE INDEX IF NOT EXISTS idx_user_preferences_key ON user_preferences(key);

CREATE INDEX IF NOT EXISTS idx_timeline_events_session_seq ON timeline_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_timeline_events_session_ts ON timeline_events(session_id, timestamp);
