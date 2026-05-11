use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const BRIDGE_CONFIG_FILE: &str = "agent-bridge.json";
pub const AGENT_DEBUG_LOG_FILE: &str = "agent-debug.log";
pub const DEFAULT_EVENT_TIMEOUT_MS: u64 = 1_000;
pub const DEFAULT_APPROVAL_TIMEOUT_MS: u64 = 20_000;
const MAX_AGENT_DEBUG_LOG_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    Codex,
    ClaudeCode,
    Opencode,
    Cursor,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentEventType {
    SessionStarted,
    TurnStarted,
    ToolStarted,
    ToolFinished,
    TurnStopped,
    AgentError,
    Heartbeat,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentStateHint {
    Thinking,
    Working,
    Editing,
    Running,
    Testing,
    Waiting,
    Success,
    Error,
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub status_events: bool,
    pub approval_decision: bool,
    pub speech: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub agent_kind: AgentKind,
    pub adapter_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: AgentEventType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<AgentCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_hint: Option<AgentStateHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApprovalRequest {
    pub request_id: String,
    pub agent_kind: AgentKind,
    pub adapter_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub timeout_ms: u64,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalDecision {
    Approve,
    Deny,
    Fallback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionInput {
    pub decision: ApprovalDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecisionResponse {
    pub decision: ApprovalDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateSnapshot {
    pub agent: &'static str,
    pub is_active: bool,
    pub active_turn_count: usize,
    pub pending_approval_count: usize,
    pub top_state: BridgeTopState,
    pub top_state_hint: AgentStateHint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_approval: Option<ApprovalView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recent_completed_turn: Option<CompletedTurnView>,
    pub sessions: Vec<AgentSessionView>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BridgeTopState {
    Idle,
    Thinking,
    Working,
    AwaitingApproval,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalView {
    pub request_id: String,
    pub agent_kind: AgentKind,
    pub adapter_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub requested_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionView {
    pub agent_kind: AgentKind,
    pub adapter_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub active_turns: Vec<AgentTurnView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnView {
    pub turn_id: String,
    pub status: AgentStateHint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedTurnView {
    pub agent_kind: AgentKind,
    pub adapter_id: String,
    pub session_id: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_summary: Option<String>,
    pub completed_at: u64,
    pub visible_until: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeConfig {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub updated_at: u64,
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn petty_config_dir() -> PathBuf {
    if let Ok(value) = env::var("PETTY_AGENT_CONFIG_DIR") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            return PathBuf::from(appdata).join("Petty");
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Petty");
        }
    }

    if let Ok(config_home) = env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(config_home).join("petty");
    }

    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(".config").join("petty");
    }

    env::temp_dir().join("petty")
}

pub fn bridge_config_path() -> PathBuf {
    petty_config_dir().join(BRIDGE_CONFIG_FILE)
}

pub fn agent_debug_log_path() -> PathBuf {
    petty_config_dir().join(AGENT_DEBUG_LOG_FILE)
}

pub fn append_agent_debug_log(line: impl AsRef<str>) {
    let path = agent_debug_log_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    if fs::metadata(&path)
        .map(|metadata| metadata.len() > MAX_AGENT_DEBUG_LOG_BYTES)
        .unwrap_or(false)
    {
        let _ = fs::write(&path, "");
    }

    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(file, "{} {}", now_millis(), line.as_ref());
}

pub fn truncate_text(value: &str, max_chars: usize) -> String {
    let mut output = String::new();
    for ch in value.trim().chars().take(max_chars) {
        output.push(ch);
    }
    output
}

pub fn project_name(cwd: Option<&str>) -> Option<String> {
    cwd.and_then(|value| {
        std::path::Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_string())
    })
}
