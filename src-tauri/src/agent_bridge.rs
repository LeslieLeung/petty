use crate::agent_protocol::{
    append_agent_debug_log, bridge_config_path, now_millis, project_name, AgentApprovalRequest,
    AgentBridgeConfig, AgentEvent, AgentEventType, AgentKind, AgentSessionView, AgentStateHint,
    AgentStateSnapshot, AgentTurnView, ApprovalDecision, ApprovalDecisionInput,
    ApprovalDecisionResponse, ApprovalView, BridgeTopState, CompletedTurnView,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const AGENT_STATE_EVENT: &str = "agent-state-changed";
const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;
const LEASE_TTL_MS: u64 = 120_000;
const COMPLETED_TURN_VISIBLE_MS: u64 = 10_000;

#[derive(Clone)]
pub struct AgentBridge {
    inner: Arc<BridgeInner>,
}

struct BridgeInner {
    data: Mutex<BridgeData>,
    approval_cv: Condvar,
    app: AppHandle,
    token: String,
    port: u16,
}

#[derive(Default)]
struct BridgeData {
    sessions: HashMap<SessionKey, SessionRecord>,
    pending_approvals: HashMap<String, PendingApproval>,
    leases: HashMap<LeaseKey, LeaseRecord>,
    recent_completed_turn: Option<CompletedTurnRecord>,
    last_error_until: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SessionKey {
    agent_kind: AgentKind,
    adapter_id: String,
    session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct LeaseKey {
    agent_kind: AgentKind,
    adapter_id: String,
    session_id: String,
}

#[derive(Clone)]
struct LeaseRecord {
    expires_at: u64,
}

struct SessionRecord {
    agent_kind: AgentKind,
    adapter_id: String,
    session_id: String,
    cwd: Option<String>,
    active_turns: HashMap<String, TurnRecord>,
    latest_state: AgentStateHint,
    started_at: u64,
    last_seen_at: u64,
}

struct TurnRecord {
    turn_id: String,
    status: AgentStateHint,
    latest_tool_name: Option<String>,
    latest_summary: Option<String>,
    started_at: u64,
}

#[derive(Clone)]
struct CompletedTurnRecord {
    agent_kind: AgentKind,
    adapter_id: String,
    session_id: String,
    turn_id: String,
    cwd: Option<String>,
    latest_tool_name: Option<String>,
    latest_summary: Option<String>,
    completed_at: u64,
    visible_until: u64,
}

struct PendingApproval {
    view: ApprovalView,
    decision: Option<ApprovalDecisionInput>,
    expires_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeInfo {
    pub host: String,
    pub port: u16,
    pub config_path: String,
}

impl AgentBridge {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let token = create_token(port);
        write_bridge_config(port, &token)?;

        let bridge = Self {
            inner: Arc::new(BridgeInner {
                data: Mutex::new(BridgeData::default()),
                approval_cv: Condvar::new(),
                app,
                token,
                port,
            }),
        };
        let server_bridge = bridge.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let request_bridge = server_bridge.clone();
                        thread::spawn(move || request_bridge.handle_stream(stream));
                    }
                    Err(error) => eprintln!("[petty-agent-bridge] accept failed: {error}"),
                }
            }
        });
        Ok(bridge)
    }

    pub fn info(&self) -> AgentBridgeInfo {
        AgentBridgeInfo {
            host: "127.0.0.1".to_string(),
            port: self.inner.port,
            config_path: bridge_config_path().display().to_string(),
        }
    }

    pub fn snapshot(&self) -> AgentStateSnapshot {
        let mut data = self.inner.data.lock().unwrap();
        prune_expired(&mut data, now_millis());
        build_snapshot(&data)
    }

    pub fn decide(
        &self,
        request_id: &str,
        decision: ApprovalDecisionInput,
    ) -> Result<AgentStateSnapshot, String> {
        {
            let mut data = self.inner.data.lock().unwrap();
            let pending = data
                .pending_approvals
                .get_mut(request_id)
                .ok_or_else(|| "approval request not found".to_string())?;
            if pending.decision.is_none() {
                pending.decision = Some(decision);
            }
            self.inner.approval_cv.notify_all();
        }
        self.emit_snapshot();
        Ok(self.snapshot())
    }

    fn apply_event(&self, event: AgentEvent) -> AgentStateSnapshot {
        {
            let mut data = self.inner.data.lock().unwrap();
            apply_event(&mut data, event);
            prune_expired(&mut data, now_millis());
        }
        self.emit_snapshot();
        self.snapshot()
    }

    fn wait_for_approval(&self, approval: AgentApprovalRequest) -> ApprovalDecisionResponse {
        let request_id = approval.request_id.clone();
        let timeout = Duration::from_millis(approval.timeout_ms.max(1));
        let deadline = Instant::now() + timeout;
        {
            let mut data = self.inner.data.lock().unwrap();
            upsert_approval(&mut data, approval);
        }
        self.emit_snapshot();

        let mut guard = self.inner.data.lock().unwrap();
        loop {
            if let Some(pending) = guard.pending_approvals.get(&request_id) {
                if let Some(decision) = &pending.decision {
                    let response = ApprovalDecisionResponse {
                        decision: decision.decision.clone(),
                        message: decision.message.clone(),
                    };
                    guard.pending_approvals.remove(&request_id);
                    drop(guard);
                    self.emit_snapshot();
                    return response;
                }
            } else {
                return ApprovalDecisionResponse {
                    decision: ApprovalDecision::Fallback,
                    message: None,
                };
            }

            let now = Instant::now();
            if now >= deadline {
                if let Some(pending) = guard.pending_approvals.get_mut(&request_id) {
                    pending.decision = Some(ApprovalDecisionInput {
                        decision: ApprovalDecision::Fallback,
                        message: None,
                    });
                }
                guard.pending_approvals.remove(&request_id);
                drop(guard);
                self.emit_snapshot();
                return ApprovalDecisionResponse {
                    decision: ApprovalDecision::Fallback,
                    message: None,
                };
            }

            let wait_for = deadline.saturating_duration_since(now);
            let (next_guard, _) = self
                .inner
                .approval_cv
                .wait_timeout(guard, wait_for)
                .unwrap();
            guard = next_guard;
        }
    }

    fn emit_snapshot(&self) {
        let snapshot = self.snapshot();
        let _ = self.inner.app.emit(AGENT_STATE_EVENT, snapshot);
    }

    fn handle_stream(&self, mut stream: TcpStream) {
        let response = match read_http_request(&mut stream) {
            Ok(request) => self.route_http(request),
            Err(error) => http_json(400, json!({ "ok": false, "error": error })),
        };
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    }

    fn route_http(&self, request: HttpRequest) -> String {
        if !self.authorized(&request) {
            return http_json(401, json!({ "ok": false, "error": "unauthorized" }));
        }

        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v1/agents/state") => http_json(200, self.snapshot()),
            ("POST", "/v1/agents/events") => {
                match serde_json::from_slice::<AgentEvent>(&request.body) {
                    Ok(event) => http_json(200, self.apply_event(event)),
                    Err(error) => {
                        http_json(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                }
            }
            ("POST", "/v1/agents/approval-requests") => {
                match serde_json::from_slice::<AgentApprovalRequest>(&request.body) {
                    Ok(approval) => http_json(200, self.wait_for_approval(approval)),
                    Err(error) => {
                        http_json(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                }
            }
            ("POST", path) if path.starts_with("/v1/approvals/") && path.ends_with("/decision") => {
                let request_id = path
                    .trim_start_matches("/v1/approvals/")
                    .trim_end_matches("/decision")
                    .trim_end_matches('/');
                match serde_json::from_slice::<ApprovalDecisionInput>(&request.body) {
                    Ok(decision) => match self.decide(request_id, decision) {
                        Ok(snapshot) => http_json(200, snapshot),
                        Err(error) => http_json(404, json!({ "ok": false, "error": error })),
                    },
                    Err(error) => {
                        http_json(400, json!({ "ok": false, "error": error.to_string() }))
                    }
                }
            }
            _ => http_json(404, json!({ "ok": false, "error": "not found" })),
        }
    }

    fn authorized(&self, request: &HttpRequest) -> bool {
        request.headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("authorization")
                && value == &format!("Bearer {}", self.inner.token)
        })
    }
}

fn apply_event(data: &mut BridgeData, event: AgentEvent) {
    let now = now_millis();
    let event_at = if event.timestamp == 0 {
        now
    } else {
        event.timestamp
    };
    let key = SessionKey {
        agent_kind: event.agent_kind.clone(),
        adapter_id: event.adapter_id.clone(),
        session_id: event.session_id.clone(),
    };
    let record = data.sessions.entry(key).or_insert_with(|| SessionRecord {
        agent_kind: event.agent_kind.clone(),
        adapter_id: event.adapter_id.clone(),
        session_id: event.session_id.clone(),
        cwd: event.cwd.clone(),
        active_turns: HashMap::new(),
        latest_state: AgentStateHint::Idle,
        started_at: event_at,
        last_seen_at: now,
    });
    if event.cwd.is_some() {
        record.cwd = event.cwd.clone();
    }
    record.last_seen_at = now;

    let state_hint = event.state_hint.clone().unwrap_or(match event.event_type {
        AgentEventType::SessionStarted => AgentStateHint::Thinking,
        AgentEventType::TurnStarted => AgentStateHint::Working,
        AgentEventType::ToolStarted => AgentStateHint::Working,
        AgentEventType::ToolFinished => AgentStateHint::Working,
        AgentEventType::TurnStopped => AgentStateHint::Idle,
        AgentEventType::AgentError => AgentStateHint::Error,
        AgentEventType::Heartbeat => record.latest_state.clone(),
    });
    record.latest_state = state_hint.clone();

    let lease_key = LeaseKey {
        agent_kind: event.agent_kind,
        adapter_id: event.adapter_id,
        session_id: event.session_id,
    };
    data.leases.insert(
        lease_key.clone(),
        LeaseRecord {
            expires_at: now + LEASE_TTL_MS,
        },
    );

    if matches!(event.event_type, AgentEventType::AgentError) {
        data.last_error_until = Some(now + 2_400);
    }

    let turn_id = event.turn_id.unwrap_or_else(|| "default".to_string());
    match event.event_type {
        AgentEventType::TurnStarted
        | AgentEventType::ToolStarted
        | AgentEventType::ToolFinished => {
            let existing = record.active_turns.remove(&turn_id);
            let latest_summary = merge_summary(
                existing
                    .as_ref()
                    .and_then(|turn| turn.latest_summary.as_deref()),
                event.summary,
            );
            record.active_turns.insert(
                turn_id.clone(),
                TurnRecord {
                    turn_id,
                    status: state_hint,
                    latest_tool_name: event.tool_name.or_else(|| {
                        existing
                            .as_ref()
                            .and_then(|turn| turn.latest_tool_name.clone())
                    }),
                    latest_summary,
                    started_at: existing
                        .as_ref()
                        .map(|turn| turn.started_at)
                        .unwrap_or(event_at),
                },
            );
        }
        AgentEventType::TurnStopped => {
            let existing = record.active_turns.remove(&turn_id);
            let existing_summary = existing
                .as_ref()
                .and_then(|turn| turn.latest_summary.as_deref());
            let incoming_summary = event.summary.clone();
            let latest_tool_name = event.tool_name.or_else(|| {
                existing
                    .as_ref()
                    .and_then(|turn| turn.latest_tool_name.clone())
            });
            let latest_summary =
                merge_completion_summary(existing_summary, incoming_summary.clone());
            append_agent_debug_log(format!(
                "[bridge] TurnStopped session={} turn={} tool={} existingSummary={} incomingSummary={} selectedSummary={}",
                lease_key.session_id,
                turn_id,
                log_option(latest_tool_name.as_deref()),
                log_option(existing_summary),
                log_option(incoming_summary.as_deref()),
                log_option(latest_summary.as_deref())
            ));
            data.recent_completed_turn = Some(CompletedTurnRecord {
                agent_kind: lease_key.agent_kind,
                adapter_id: lease_key.adapter_id,
                session_id: lease_key.session_id,
                turn_id,
                cwd: record.cwd.clone(),
                latest_tool_name,
                latest_summary,
                completed_at: now,
                visible_until: now + COMPLETED_TURN_VISIBLE_MS,
            });
        }
        _ => {}
    }
}

fn merge_summary(existing: Option<&str>, incoming: Option<String>) -> Option<String> {
    match (existing, incoming) {
        (Some(current), Some(next))
            if current.starts_with("file:") && !next.starts_with("file:") =>
        {
            Some(current.to_string())
        }
        (Some(current), Some(next)) if looks_like_internal_tool_id(&next) => {
            Some(current.to_string())
        }
        (_, Some(next)) => Some(next),
        (Some(current), None) => Some(current.to_string()),
        (None, None) => None,
    }
}

fn merge_completion_summary(existing: Option<&str>, incoming: Option<String>) -> Option<String> {
    match (existing, incoming) {
        (Some(current), Some(next))
            if is_structured_tool_summary(current) && !is_structured_tool_summary(&next) =>
        {
            Some(current.to_string())
        }
        (Some(current), Some(next)) if looks_like_internal_tool_id(&next) => {
            Some(current.to_string())
        }
        (_, Some(next)) if !looks_like_internal_tool_id(&next) => Some(next),
        (Some(current), _) => Some(current.to_string()),
        (None, _) => None,
    }
}

fn is_structured_tool_summary(value: &str) -> bool {
    value.starts_with("file:") || value.starts_with("read-file:")
}

fn looks_like_internal_tool_id(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("call_")
        || (trimmed.len() >= 16
            && trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
}

fn log_option(value: Option<&str>) -> String {
    value
        .map(|value| format!("{:?}", crate::agent_protocol::truncate_text(value, 180)))
        .unwrap_or_else(|| "<none>".to_string())
}

fn upsert_approval(data: &mut BridgeData, approval: AgentApprovalRequest) {
    let now = now_millis();
    let approval_at = if approval.timestamp == 0 {
        now
    } else {
        approval.timestamp
    };
    let key = SessionKey {
        agent_kind: approval.agent_kind.clone(),
        adapter_id: approval.adapter_id.clone(),
        session_id: approval.session_id.clone(),
    };
    data.sessions.entry(key).or_insert_with(|| SessionRecord {
        agent_kind: approval.agent_kind.clone(),
        adapter_id: approval.adapter_id.clone(),
        session_id: approval.session_id.clone(),
        cwd: approval.cwd.clone(),
        active_turns: HashMap::new(),
        latest_state: AgentStateHint::Waiting,
        started_at: approval_at,
        last_seen_at: now,
    });

    let project = project_name(approval.cwd.as_deref());
    let view = ApprovalView {
        request_id: approval.request_id.clone(),
        agent_kind: approval.agent_kind,
        adapter_id: approval.adapter_id,
        session_id: approval.session_id,
        turn_id: approval.turn_id,
        cwd: approval.cwd,
        project,
        tool_name: approval.tool_name,
        summary: approval.summary,
        reason: approval.reason,
        requested_at: now,
    };
    data.pending_approvals.insert(
        approval.request_id,
        PendingApproval {
            view,
            decision: None,
            expires_at: now + approval.timeout_ms.max(1),
        },
    );
}

fn prune_expired(data: &mut BridgeData, now: u64) {
    data.leases.retain(|_, lease| lease.expires_at > now);
    data.pending_approvals
        .retain(|_, approval| approval.expires_at > now || approval.decision.is_some());
    if data
        .last_error_until
        .is_some_and(|expires_at| expires_at <= now)
    {
        data.last_error_until = None;
    }
    if data
        .recent_completed_turn
        .as_ref()
        .is_some_and(|turn| turn.visible_until <= now)
    {
        data.recent_completed_turn = None;
    }

    let active_leases = data.leases.clone();
    data.sessions.retain(|key, session| {
        let has_active_lease = active_leases.contains_key(&LeaseKey {
            agent_kind: key.agent_kind.clone(),
            adapter_id: key.adapter_id.clone(),
            session_id: key.session_id.clone(),
        });
        if !has_active_lease {
            session.active_turns.clear();
            session.latest_state = AgentStateHint::Idle;
        }
        has_active_lease || !session.active_turns.is_empty()
    });
}

fn build_snapshot(data: &BridgeData) -> AgentStateSnapshot {
    let visible_approvals: Vec<&PendingApproval> = data
        .pending_approvals
        .values()
        .filter(|approval| approval.decision.is_none())
        .collect();
    let active_approval = visible_approvals
        .iter()
        .copied()
        .max_by_key(|approval| approval.view.requested_at)
        .map(|approval| approval.view.clone());
    let active_turn_count = data
        .sessions
        .values()
        .map(|session| session.active_turns.len())
        .sum();
    let recent_completed_turn = data
        .recent_completed_turn
        .as_ref()
        .map(|turn| CompletedTurnView {
            agent_kind: turn.agent_kind.clone(),
            adapter_id: turn.adapter_id.clone(),
            session_id: turn.session_id.clone(),
            turn_id: turn.turn_id.clone(),
            cwd: turn.cwd.clone(),
            latest_tool_name: turn.latest_tool_name.clone(),
            latest_summary: turn.latest_summary.clone(),
            completed_at: turn.completed_at,
            visible_until: turn.visible_until,
        });
    let has_error = data.last_error_until.is_some();
    let strongest = strongest_state(data);
    let top_state = if active_approval.is_some() {
        BridgeTopState::AwaitingApproval
    } else if has_error || strongest == AgentStateHint::Error {
        BridgeTopState::Error
    } else if matches!(
        strongest,
        AgentStateHint::Working
            | AgentStateHint::Editing
            | AgentStateHint::Running
            | AgentStateHint::Testing
            | AgentStateHint::Waiting
    ) {
        BridgeTopState::Working
    } else if strongest == AgentStateHint::Thinking {
        BridgeTopState::Thinking
    } else {
        BridgeTopState::Idle
    };
    let top_state_hint = if active_approval.is_some() {
        AgentStateHint::Waiting
    } else if has_error {
        AgentStateHint::Error
    } else if active_turn_count == 0 && recent_completed_turn.is_some() {
        AgentStateHint::Success
    } else {
        strongest
    };

    AgentStateSnapshot {
        agent: "coding-agent",
        is_active: active_turn_count > 0 || active_approval.is_some(),
        active_turn_count,
        pending_approval_count: visible_approvals.len(),
        top_state,
        top_state_hint,
        active_approval,
        recent_completed_turn,
        sessions: sorted_sessions(data)
            .into_iter()
            .map(|session| {
                let mut active_turns: Vec<&TurnRecord> = session.active_turns.values().collect();
                active_turns.sort_by_key(|turn| turn.started_at);
                AgentSessionView {
                    agent_kind: session.agent_kind.clone(),
                    adapter_id: session.adapter_id.clone(),
                    session_id: session.session_id.clone(),
                    cwd: session.cwd.clone(),
                    active_turns: active_turns
                        .into_iter()
                        .map(|turn| AgentTurnView {
                            turn_id: turn.turn_id.clone(),
                            status: turn.status.clone(),
                            latest_tool_name: turn.latest_tool_name.clone(),
                            latest_summary: turn.latest_summary.clone(),
                        })
                        .collect(),
                }
            })
            .collect(),
    }
}

fn sorted_sessions(data: &BridgeData) -> Vec<&SessionRecord> {
    let mut sessions: Vec<&SessionRecord> = data
        .sessions
        .values()
        .filter(|session| !session.active_turns.is_empty())
        .collect();
    sessions.sort_by_key(|session| {
        session
            .active_turns
            .values()
            .map(|turn| turn.started_at)
            .min()
            .unwrap_or(session.started_at)
    });
    sessions
}

fn strongest_state(data: &BridgeData) -> AgentStateHint {
    data.sessions
        .values()
        .flat_map(|session| {
            let mut states = vec![session.latest_state.clone()];
            states.extend(
                session
                    .active_turns
                    .values()
                    .map(|turn| turn.status.clone()),
            );
            states
        })
        .max_by_key(state_priority)
        .unwrap_or(AgentStateHint::Idle)
}

fn state_priority(state: &AgentStateHint) -> u8 {
    match state {
        AgentStateHint::Error => 90,
        AgentStateHint::Testing => 70,
        AgentStateHint::Running => 68,
        AgentStateHint::Editing => 66,
        AgentStateHint::Working => 64,
        AgentStateHint::Waiting => 62,
        AgentStateHint::Thinking => 40,
        AgentStateHint::Success => 30,
        AgentStateHint::Idle => 0,
    }
}

fn write_bridge_config(port: u16, token: &str) -> Result<(), String> {
    let path = bridge_config_path();
    let parent = path
        .parent()
        .ok_or_else(|| "bridge config has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let config = AgentBridgeConfig {
        host: "127.0.0.1".to_string(),
        port,
        token: token.to_string(),
        updated_at: now_millis(),
    };
    let text = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    fs::write(path, format!("{text}\n")).map_err(|error| error.to_string())
}

fn create_token(port: u16) -> String {
    format!("petty-{}-{}-{}", std::process::id(), port, now_millis())
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 2048];
    let header_end;
    loop {
        let read = stream.read(&mut temp).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("connection closed before request".to_string());
        }
        buffer.extend_from_slice(&temp[..read]);
        if buffer.len() > MAX_HTTP_BODY_BYTES {
            return Err("request is too large".to_string());
        }
        if let Some(index) = find_header_end(&buffer) {
            header_end = index;
            break;
        }
    }

    let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "missing method".to_string())?
        .to_string();
    let path = parts
        .next()
        .ok_or_else(|| "missing path".to_string())?
        .to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    let content_length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_HTTP_BODY_BYTES {
        return Err("request body is too large".to_string());
    }

    let mut body = buffer[(header_end + 4)..].to_vec();
    while body.len() < content_length {
        let read = stream.read(&mut temp).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&temp[..read]);
    }
    body.truncate(content_length);

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn http_json<T: Serialize>(status: u16, body: T) -> String {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let body = serde_json::to_string(&body).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    )
}

pub fn read_bridge_config(path: &Path) -> Result<AgentBridgeConfig, String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

pub fn post_json<T: Serialize>(
    config: &AgentBridgeConfig,
    path: &str,
    body: &T,
    timeout: Duration,
) -> Result<Value, String> {
    let body = serde_json::to_string(body).map_err(|error| error.to_string())?;
    http_request(config, "POST", path, Some(body), timeout)
}

pub fn get_json(
    config: &AgentBridgeConfig,
    path: &str,
    timeout: Duration,
) -> Result<Value, String> {
    http_request(config, "GET", path, None, timeout)
}

fn http_request(
    config: &AgentBridgeConfig,
    method: &str,
    path: &str,
    body: Option<String>,
    timeout: Duration,
) -> Result<Value, String> {
    let mut stream = TcpStream::connect((config.host.as_str(), config.port))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let body_text = body.unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {}:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        config.host,
        config.port,
        config.token,
        body_text.as_bytes().len(),
        body_text
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    let split = find_header_end(&response).ok_or_else(|| "invalid HTTP response".to_string())?;
    let status_line = String::from_utf8_lossy(&response[..split])
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    if !status_line.contains(" 200 ") {
        return Err(status_line);
    }
    serde_json::from_slice(&response[(split + 4)..]).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregation_prefers_approval() {
        let mut data = BridgeData::default();
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::TurnStarted,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Working),
                tool_name: None,
                summary: None,
                timestamp: now_millis(),
            },
        );
        upsert_approval(
            &mut data,
            AgentApprovalRequest {
                request_id: "r1".to_string(),
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                cwd: None,
                tool_name: Some("Bash".to_string()),
                summary: None,
                reason: None,
                timeout_ms: 20_000,
                timestamp: now_millis(),
            },
        );
        let snapshot = build_snapshot(&data);
        assert_eq!(snapshot.top_state, BridgeTopState::AwaitingApproval);
        assert_eq!(snapshot.pending_approval_count, 1);
    }

    #[test]
    fn turn_stop_clears_active_turn() {
        let mut data = BridgeData::default();
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::TurnStarted,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Working),
                tool_name: None,
                summary: None,
                timestamp: now_millis(),
            },
        );
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::TurnStopped,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Idle),
                tool_name: None,
                summary: None,
                timestamp: now_millis(),
            },
        );
        assert_eq!(build_snapshot(&data).active_turn_count, 0);
    }

    #[test]
    fn turn_stop_preserves_structured_tool_summary() {
        let mut data = BridgeData::default();
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::ToolStarted,
                cwd: Some("/tmp/project".to_string()),
                capabilities: None,
                state_hint: Some(AgentStateHint::Editing),
                tool_name: Some("apply_patch".to_string()),
                summary: Some("file:src/main.ts".to_string()),
                timestamp: now_millis(),
            },
        );
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::TurnStopped,
                cwd: Some("/tmp/project".to_string()),
                capabilities: None,
                state_hint: Some(AgentStateHint::Idle),
                tool_name: None,
                summary: Some("Implemented the requested task bubble behavior.".to_string()),
                timestamp: now_millis(),
            },
        );

        let snapshot = build_snapshot(&data);
        let completed = snapshot.recent_completed_turn.unwrap();
        assert_eq!(snapshot.active_turn_count, 0);
        assert_eq!(snapshot.top_state_hint, AgentStateHint::Success);
        assert_eq!(
            completed.latest_summary.as_deref(),
            Some("file:src/main.ts")
        );
        assert_eq!(completed.latest_tool_name.as_deref(), Some("apply_patch"));
    }

    #[test]
    fn turn_stop_uses_completion_summary_without_structured_tool_summary() {
        let mut data = BridgeData::default();
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::ToolStarted,
                cwd: Some("/tmp/project".to_string()),
                capabilities: None,
                state_hint: Some(AgentStateHint::Running),
                tool_name: Some("Bash".to_string()),
                summary: Some("npm run build".to_string()),
                timestamp: now_millis(),
            },
        );
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::TurnStopped,
                cwd: Some("/tmp/project".to_string()),
                capabilities: None,
                state_hint: Some(AgentStateHint::Idle),
                tool_name: None,
                summary: Some("Build completed successfully.".to_string()),
                timestamp: now_millis(),
            },
        );

        let snapshot = build_snapshot(&data);
        let completed = snapshot.recent_completed_turn.unwrap();
        assert_eq!(
            completed.latest_summary.as_deref(),
            Some("Build completed successfully.")
        );
    }

    #[test]
    fn expired_session_lease_clears_stale_active_turn() {
        let mut data = BridgeData::default();
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::TurnStarted,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Working),
                tool_name: None,
                summary: None,
                timestamp: now_millis(),
            },
        );

        prune_expired(&mut data, now_millis() + LEASE_TTL_MS + 1);
        let snapshot = build_snapshot(&data);
        assert_eq!(snapshot.active_turn_count, 0);
        assert_eq!(snapshot.top_state, BridgeTopState::Idle);
    }

    #[test]
    fn tool_finished_preserves_file_summary() {
        let mut data = BridgeData::default();
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::ToolStarted,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Editing),
                tool_name: Some("apply_patch".to_string()),
                summary: Some("file:src/main.ts".to_string()),
                timestamp: now_millis(),
            },
        );
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::ToolFinished,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Working),
                tool_name: Some("apply_patch".to_string()),
                summary: Some("call_abc123def456ghi789".to_string()),
                timestamp: now_millis(),
            },
        );

        let snapshot = build_snapshot(&data);
        let turn = &snapshot.sessions[0].active_turns[0];
        assert_eq!(turn.latest_summary.as_deref(), Some("file:src/main.ts"));
    }

    #[test]
    fn snapshot_preserves_task_order_when_status_changes() {
        let mut data = BridgeData::default();
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::TurnStarted,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Working),
                tool_name: None,
                summary: Some("first task".to_string()),
                timestamp: 10,
            },
        );
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s2".to_string(),
                turn_id: Some("t2".to_string()),
                event_type: AgentEventType::TurnStarted,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Working),
                tool_name: None,
                summary: Some("second task".to_string()),
                timestamp: 20,
            },
        );
        apply_event(
            &mut data,
            AgentEvent {
                agent_kind: AgentKind::Codex,
                adapter_id: "codex".to_string(),
                session_id: "s1".to_string(),
                turn_id: Some("t1".to_string()),
                event_type: AgentEventType::ToolStarted,
                cwd: None,
                capabilities: None,
                state_hint: Some(AgentStateHint::Testing),
                tool_name: Some("cargo test".to_string()),
                summary: Some("cargo test".to_string()),
                timestamp: 30,
            },
        );

        let snapshot = build_snapshot(&data);
        assert_eq!(snapshot.sessions[0].session_id, "s1");
        assert_eq!(snapshot.sessions[1].session_id, "s2");
        assert_eq!(
            snapshot.sessions[0].active_turns[0].status,
            AgentStateHint::Testing
        );
    }
}
