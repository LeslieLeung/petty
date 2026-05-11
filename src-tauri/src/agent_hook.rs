use crate::agent_protocol::{
    append_agent_debug_log, now_millis, truncate_text, AgentApprovalRequest, AgentCapabilities,
    AgentEvent, AgentEventType, AgentKind, AgentStateHint, ApprovalDecision,
    DEFAULT_APPROVAL_TIMEOUT_MS,
};
use serde_json::Value;
use std::fs;

const CODEX_ADAPTER_ID: &str = "codex-hooks";
const CURSOR_ADAPTER_ID: &str = "cursor-hooks";

#[derive(Debug, Clone)]
pub enum HookBridgeMessage {
    Event(AgentEvent),
    Approval(AgentApprovalRequest),
    None,
}

pub fn map_hook_input(
    agent: &str,
    hook_event: &str,
    input: &Value,
) -> Result<HookBridgeMessage, String> {
    match agent {
        "codex" => map_codex_hook_input(hook_event, input),
        "cursor" => map_cursor_hook_input(hook_event, input),
        other => Err(format!("unsupported agent: {other}")),
    }
}

pub fn codex_stdout_for_decision(decision: ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Approve => "{\"decision\":\"allow\"}\n",
        ApprovalDecision::Deny => "{\"decision\":\"deny\"}\n",
        ApprovalDecision::Fallback => "{}\n",
    }
}

fn map_cursor_hook_input(hook_event: &str, input: &Value) -> Result<HookBridgeMessage, String> {
    // conversation_id is stable across turns; generation_id changes per user message.
    let session_id = optional_string(input, "conversation_id")
        .or_else(|| optional_string(input, "session_id"))
        .unwrap_or_else(|| "cursor-session-unknown".to_string());
    let turn_id = optional_string(input, "generation_id");
    let cwd = optional_string(input, "cwd").or_else(|| {
        input
            .get("workspace_roots")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });
    let tool_name =
        optional_string(input, "tool_name").or_else(|| optional_string(input, "toolName"));
    let tool_use_id =
        optional_string(input, "tool_use_id").or_else(|| optional_string(input, "toolUseId"));
    let timestamp = now_millis();
    let capabilities = Some(AgentCapabilities {
        status_events: true,
        approval_decision: false,
        speech: false,
    });

    let event = |event_type: AgentEventType,
                 state_hint: Option<AgentStateHint>,
                 summary: Option<String>| {
        HookBridgeMessage::Event(AgentEvent {
            agent_kind: AgentKind::Cursor,
            adapter_id: CURSOR_ADAPTER_ID.to_string(),
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            event_type,
            cwd: cwd.clone(),
            capabilities: capabilities.clone(),
            state_hint,
            tool_name: tool_name.clone(),
            summary,
            timestamp,
        })
    };

    match hook_event {
        "sessionStart" => Ok(event(
            AgentEventType::SessionStarted,
            Some(AgentStateHint::Thinking),
            None,
        )),
        "beforeSubmitPrompt" => {
            let summary =
                optional_string(input, "prompt").map(|p| first_line(&truncate_text(&p, 180)));
            Ok(event(
                AgentEventType::TurnStarted,
                Some(AgentStateHint::Working),
                summary,
            ))
        }
        "preToolUse" => Ok(event(
            AgentEventType::ToolStarted,
            state_for_tool(tool_name.as_deref()),
            tool_summary(input).or_else(|| tool_use_id.clone()),
        )),
        "postToolUse" => Ok(event(
            AgentEventType::ToolFinished,
            state_for_tool(tool_name.as_deref()),
            tool_summary(input).or(tool_use_id),
        )),
        "stop" | "sessionEnd" => {
            let state_hint = match optional_string(input, "status").as_deref() {
                Some("error") => AgentStateHint::Error,
                _ => AgentStateHint::Idle,
            };
            Ok(event(AgentEventType::TurnStopped, Some(state_hint), None))
        }
        _ => Ok(HookBridgeMessage::None),
    }
}

fn map_codex_hook_input(hook_event: &str, input: &Value) -> Result<HookBridgeMessage, String> {
    let session_id = optional_string(input, "session_id")
        .or_else(|| optional_string(input, "sessionId"))
        .unwrap_or_else(|| "codex-session-unknown".to_string());
    let turn_id = optional_string(input, "turn_id").or_else(|| optional_string(input, "turnId"));
    let cwd = optional_string(input, "cwd");
    let tool_name =
        optional_string(input, "tool_name").or_else(|| optional_string(input, "toolName"));
    let tool_use_id =
        optional_string(input, "tool_use_id").or_else(|| optional_string(input, "toolUseId"));
    let timestamp = now_millis();
    let capabilities = Some(AgentCapabilities {
        status_events: true,
        approval_decision: true,
        speech: false,
    });

    debug_codex_hook_input(hook_event, input);

    let event = |event_type: AgentEventType,
                 state_hint: Option<AgentStateHint>,
                 summary: Option<String>| {
        HookBridgeMessage::Event(AgentEvent {
            agent_kind: AgentKind::Codex,
            adapter_id: CODEX_ADAPTER_ID.to_string(),
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            event_type,
            cwd: cwd.clone(),
            capabilities: capabilities.clone(),
            state_hint,
            tool_name: tool_name.clone(),
            summary,
            timestamp,
        })
    };

    match hook_event {
        "SessionStart" => Ok(event(
            AgentEventType::SessionStarted,
            Some(AgentStateHint::Thinking),
            optional_string(input, "source"),
        )),
        "UserPromptSubmit" => Ok(event(
            AgentEventType::TurnStarted,
            Some(AgentStateHint::Working),
            prompt_summary(input),
        )),
        "PreToolUse" => Ok(event(
            AgentEventType::ToolStarted,
            state_for_tool(tool_name.as_deref()),
            tool_summary(input).or(tool_use_id),
        )),
        "PostToolUse" => Ok(event(
            AgentEventType::ToolFinished,
            state_for_tool(tool_name.as_deref()),
            tool_summary(input).or(tool_use_id),
        )),
        "PermissionRequest" => {
            let request_id =
                request_id(&session_id, turn_id.as_deref(), tool_name.as_deref(), input);
            Ok(HookBridgeMessage::Approval(AgentApprovalRequest {
                request_id,
                agent_kind: AgentKind::Codex,
                adapter_id: CODEX_ADAPTER_ID.to_string(),
                session_id,
                turn_id,
                cwd,
                tool_name,
                summary: tool_summary(input),
                reason: optional_string(input, "reason")
                    .or_else(|| nested_string(input, &["tool_input", "description"]))
                    .or_else(|| nested_string(input, &["toolInput", "description"]))
                    .map(|value| truncate_text(&value, 180)),
                timeout_ms: DEFAULT_APPROVAL_TIMEOUT_MS,
                timestamp,
            }))
        }
        "Stop" => {
            let summary = optional_string(input, "last_assistant_message")
                .or_else(|| optional_string(input, "lastAssistantMessage"))
                .map(|message| truncate_text(&message, 160));
            append_agent_debug_log(format!(
                "[hook:codex] Stop mapped turnId={} summary={}",
                turn_id.as_deref().unwrap_or("<none>"),
                log_option(summary.as_deref())
            ));
            Ok(event(
                AgentEventType::TurnStopped,
                Some(AgentStateHint::Idle),
                summary,
            ))
        }
        _ => Ok(HookBridgeMessage::None),
    }
}

fn debug_codex_hook_input(hook_event: &str, input: &Value) {
    let keys = input
        .as_object()
        .map(|object| {
            let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
            keys.sort_unstable();
            keys.join(",")
        })
        .unwrap_or_else(|| "<non-object>".to_string());
    let tool_input_keys = object_keys(input.get("tool_input"))
        .or_else(|| object_keys(input.get("toolInput")))
        .or_else(|| object_keys(input.get("arguments")))
        .unwrap_or_else(|| "<none>".to_string());
    append_agent_debug_log(format!(
        "[hook:codex] event={} keys={} toolInputKeys={} session={} turn={} tool={} summary={} fileSummary={} toolDescription={} command={} lastAssistant={}",
        hook_event,
        keys,
        tool_input_keys,
        log_option(optional_string(input, "session_id").or_else(|| optional_string(input, "sessionId")).as_deref()),
        log_option(optional_string(input, "turn_id").or_else(|| optional_string(input, "turnId")).as_deref()),
        log_option(optional_string(input, "tool_name").or_else(|| optional_string(input, "toolName")).as_deref()),
        log_option(optional_string(input, "summary").as_deref()),
        log_option(file_summary(input).as_deref()),
        log_option(nested_string(input, &["tool_input", "description"]).or_else(|| nested_string(input, &["toolInput", "description"])).as_deref()),
        log_option(command_string(input).as_deref()),
        log_option(optional_string(input, "last_assistant_message").or_else(|| optional_string(input, "lastAssistantMessage")).as_deref())
    ));
}

fn object_keys(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_object).map(|object| {
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        keys.join(",")
    })
}

fn log_option(value: Option<&str>) -> String {
    value
        .map(|value| format!("{:?}", truncate_text(value, 180)))
        .unwrap_or_else(|| "<none>".to_string())
}

fn request_id(
    session_id: &str,
    turn_id: Option<&str>,
    tool_name: Option<&str>,
    input: &Value,
) -> String {
    optional_string(input, "request_id")
        .or_else(|| optional_string(input, "requestId"))
        .or_else(|| optional_string(input, "tool_use_id"))
        .or_else(|| optional_string(input, "toolUseId"))
        .unwrap_or_else(|| {
            format!(
                "codex-{}-{}-{}-{}",
                sanitize_id(session_id),
                sanitize_id(turn_id.unwrap_or("turn")),
                sanitize_id(tool_name.unwrap_or("tool")),
                now_millis()
            )
        })
}

fn state_for_tool(tool_name: Option<&str>) -> Option<AgentStateHint> {
    let tool = tool_name.unwrap_or_default().to_ascii_lowercase();
    if tool.contains("apply_patch") || tool.contains("edit") || tool.contains("write") {
        Some(AgentStateHint::Editing)
    } else if tool.contains("test") {
        Some(AgentStateHint::Testing)
    } else if tool.contains("bash") || tool.contains("shell") || tool.contains("exec") {
        Some(AgentStateHint::Running)
    } else {
        Some(AgentStateHint::Working)
    }
}

fn tool_summary(input: &Value) -> Option<String> {
    file_summary(input)
        .or_else(|| optional_string(input, "summary"))
        .or_else(|| nested_string(input, &["tool_input", "description"]))
        .or_else(|| nested_string(input, &["toolInput", "description"]))
        .or_else(|| command_string(input))
        .map(|value| first_line(&truncate_text(&value, 180)))
}

fn prompt_summary(input: &Value) -> Option<String> {
    optional_string(input, "summary")
        .or_else(|| optional_string(input, "prompt"))
        .map(|value| first_line(&truncate_text(&value, 180)))
}

fn file_summary(input: &Value) -> Option<String> {
    if let Some(path) = nested_string(input, &["tool_input", "file_path"])
        .or_else(|| nested_string(input, &["toolInput", "filePath"]))
        .or_else(|| nested_string(input, &["tool_input", "path"]))
        .or_else(|| nested_string(input, &["toolInput", "path"]))
        .or_else(|| nested_string(input, &["tool_input", "file"]))
        .or_else(|| nested_string(input, &["toolInput", "file"]))
        .or_else(|| nested_string(input, &["arguments", "file_path"]))
        .or_else(|| nested_string(input, &["arguments", "filePath"]))
        .or_else(|| nested_string(input, &["arguments", "path"]))
        .or_else(|| nested_string(input, &["arguments", "file"]))
        .or_else(|| nested_string(input, &["input", "file_path"]))
        .or_else(|| nested_string(input, &["input", "filePath"]))
        .or_else(|| nested_string(input, &["input", "path"]))
        .or_else(|| nested_string(input, &["input", "file"]))
    {
        return Some(format!("file:{}", truncate_text(&path, 120)));
    }

    if let Some(path) = strings_from_tool_payloads(input)
        .iter()
        .find_map(|value| patch_file_path(value))
    {
        return Some(format!("file:{}", truncate_text(&path, 120)));
    }

    if let Some(path) = transcript_file_path(input) {
        return Some(format!("file:{}", truncate_text(&path, 120)));
    }

    command_string(input)
        .and_then(|command| read_file_path_from_command(&command))
        .map(|path| format!("read-file:{}", truncate_text(&path, 120)))
}

fn patch_file_path(value: &str) -> Option<String> {
    value.lines().find_map(|line| {
        line.strip_prefix("*** Update File: ")
            .or_else(|| line.strip_prefix("*** Add File: "))
            .or_else(|| line.strip_prefix("*** Delete File: "))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
    })
}

fn strings_from_tool_payloads(input: &Value) -> Vec<String> {
    let mut output = Vec::new();
    for key in ["tool_input", "toolInput", "arguments", "input", "params"] {
        if let Some(value) = input.get(key) {
            collect_strings(value, &mut output);
        }
    }
    output
}

fn collect_strings(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(text) if !text.trim().is_empty() => output.push(text.trim().to_string()),
        Value::Array(items) => {
            for item in items {
                collect_strings(item, output);
            }
        }
        Value::Object(object) => {
            for value in object.values() {
                collect_strings(value, output);
            }
        }
        _ => {}
    }
}

fn transcript_file_path(input: &Value) -> Option<String> {
    let transcript_path = optional_string(input, "transcript_path")
        .or_else(|| optional_string(input, "transcriptPath"))?;
    let transcript = fs::read_to_string(transcript_path).ok()?;
    let tool_use_id =
        optional_string(input, "tool_use_id").or_else(|| optional_string(input, "toolUseId"));
    let tool_name =
        optional_string(input, "tool_name").or_else(|| optional_string(input, "toolName"));

    transcript.lines().rev().find_map(|line| {
        let record: Value = serde_json::from_str(line).ok()?;
        let payload = record.get("payload")?;
        let payload_type = optional_string(payload, "type")?;
        if !matches!(payload_type.as_str(), "custom_tool_call" | "function_call") {
            return None;
        }
        if !transcript_tool_matches(payload, tool_use_id.as_deref(), tool_name.as_deref()) {
            return None;
        }

        let mut strings = Vec::new();
        collect_strings(payload, &mut strings);
        strings.iter().find_map(|value| patch_file_path(value))
    })
}

fn transcript_tool_matches(
    payload: &Value,
    tool_use_id: Option<&str>,
    tool_name: Option<&str>,
) -> bool {
    if let Some(expected_id) = tool_use_id {
        let actual_id = optional_string(payload, "call_id")
            .or_else(|| optional_string(payload, "callId"))
            .or_else(|| optional_string(payload, "id"));
        return actual_id.as_deref() == Some(expected_id);
    }

    let Some(expected_name) = tool_name else {
        return true;
    };
    let Some(actual_name) = optional_string(payload, "name") else {
        return false;
    };
    tool_names_match(&actual_name, expected_name)
}

fn tool_names_match(actual: &str, expected: &str) -> bool {
    let actual = actual.rsplit('.').next().unwrap_or(actual);
    let expected = expected.rsplit('.').next().unwrap_or(expected);
    actual.eq_ignore_ascii_case(expected)
}

fn command_string(input: &Value) -> Option<String> {
    nested_string(input, &["tool_input", "command"])
        .or_else(|| nested_string(input, &["toolInput", "command"]))
        .or_else(|| nested_string(input, &["tool_input", "cmd"]))
        .or_else(|| nested_string(input, &["toolInput", "cmd"]))
        .or_else(|| nested_string(input, &["arguments", "command"]))
        .or_else(|| nested_string(input, &["arguments", "cmd"]))
        .or_else(|| nested_string(input, &["input", "command"]))
        .or_else(|| nested_string(input, &["input", "cmd"]))
}

fn read_file_path_from_command(command: &str) -> Option<String> {
    command
        .split('|')
        .find_map(|segment| read_file_path_from_command_segment(segment.trim()))
}

fn read_file_path_from_command_segment(segment: &str) -> Option<String> {
    let words = shell_words(segment);
    let command = words.first()?.rsplit('/').next()?.to_ascii_lowercase();
    if !matches!(
        command.as_str(),
        "cat" | "sed" | "nl" | "tail" | "head" | "less" | "more"
    ) {
        return None;
    }

    words
        .iter()
        .skip(1)
        .filter(|word| looks_like_file_argument(word))
        .next()
        .cloned()
}

fn looks_like_file_argument(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('-')
        || trimmed.starts_with('$')
        || trimmed.contains('*')
        || trimmed.contains('{')
        || trimmed.contains('}')
    {
        return false;
    }
    trimmed.contains('/') || trimmed.contains('.')
}

fn shell_words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in value.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }

    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn optional_string(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn nested_string(input: &Value, path: &[&str]) -> Option<String> {
    let mut cursor = input;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn first_line(value: &str) -> String {
    value.lines().next().unwrap_or(value).trim().to_string()
}

fn sanitize_id(value: &str) -> String {
    let mut output = String::new();
    for ch in value.chars().take(48) {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            output.push(ch);
        } else {
            output.push('-');
        }
    }
    output.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_codex_prompt_to_turn_started() {
        let input = json!({
            "session_id": "s1",
            "turn_id": "t1",
            "cwd": "/tmp/project",
            "prompt": "fix it"
        });
        let mapped = map_hook_input("codex", "UserPromptSubmit", &input).unwrap();
        match mapped {
            HookBridgeMessage::Event(event) => {
                assert_eq!(event.agent_kind, AgentKind::Codex);
                assert_eq!(event.event_type, AgentEventType::TurnStarted);
                assert_eq!(event.state_hint, Some(AgentStateHint::Working));
                assert_eq!(event.summary.as_deref(), Some("fix it"));
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn maps_codex_post_tool_use_to_tool_state() {
        let input = json!({
            "session_id": "s1",
            "turn_id": "t1",
            "tool_name": "apply_patch",
            "tool_input": { "file_path": "src/i18n.ts" }
        });
        let mapped = map_hook_input("codex", "PostToolUse", &input).unwrap();
        match mapped {
            HookBridgeMessage::Event(event) => {
                assert_eq!(event.state_hint, Some(AgentStateHint::Editing));
                assert_eq!(event.summary.as_deref(), Some("file:src/i18n.ts"));
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn maps_codex_permission_to_approval() {
        let input = json!({
            "session_id": "s1",
            "turn_id": "t1",
            "tool_name": "Bash",
            "tool_input": { "command": "git push origin main", "description": "Push" }
        });
        let mapped = map_hook_input("codex", "PermissionRequest", &input).unwrap();
        match mapped {
            HookBridgeMessage::Approval(approval) => {
                assert_eq!(approval.agent_kind, AgentKind::Codex);
                assert_eq!(approval.summary.as_deref(), Some("Push"));
                assert_eq!(approval.reason.as_deref(), Some("Push"));
            }
            _ => panic!("expected approval"),
        }
    }

    #[test]
    fn extracts_apply_patch_file_summary() {
        let input = json!({
            "session_id": "s1",
            "turn_id": "t1",
            "tool_name": "apply_patch",
            "tool_input": {
                "cmd": "*** Begin Patch\n*** Update File: src/main.ts\n@@\n-foo\n+bar\n*** End Patch"
            }
        });
        let mapped = map_hook_input("codex", "PreToolUse", &input).unwrap();
        match mapped {
            HookBridgeMessage::Event(event) => {
                assert_eq!(event.summary.as_deref(), Some("file:src/main.ts"));
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn extracts_nested_apply_patch_file_summary() {
        let input = json!({
            "session_id": "s1",
            "turn_id": "t1",
            "tool_name": "functions.apply_patch",
            "arguments": {
                "patch": "*** Begin Patch\n*** Update File: src/settings.ts\n@@\n-foo\n+bar\n*** End Patch"
            }
        });
        let mapped = map_hook_input("codex", "PreToolUse", &input).unwrap();
        match mapped {
            HookBridgeMessage::Event(event) => {
                assert_eq!(event.summary.as_deref(), Some("file:src/settings.ts"));
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn extracts_apply_patch_file_summary_from_transcript() {
        let transcript_path = std::env::temp_dir().join(format!(
            "petty-agent-hook-transcript-{}.jsonl",
            now_millis()
        ));
        let transcript = serde_json::json!({
            "timestamp": "2026-05-10T17:00:29.782Z",
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "call_id": "call_patch",
                "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: /Users/leslieleung/Projects/petty/src/styles.css\n@@\n-foo\n+bar\n*** End Patch"
            }
        });
        std::fs::write(&transcript_path, format!("{transcript}\n")).unwrap();

        let input = json!({
            "session_id": "s1",
            "turn_id": "t1",
            "tool_name": "apply_patch",
            "tool_use_id": "call_patch",
            "transcript_path": transcript_path
        });
        let mapped = map_hook_input("codex", "PreToolUse", &input).unwrap();
        let _ = std::fs::remove_file(
            input
                .get("transcript_path")
                .and_then(Value::as_str)
                .unwrap(),
        );

        match mapped {
            HookBridgeMessage::Event(event) => {
                assert_eq!(
                    event.summary.as_deref(),
                    Some("file:/Users/leslieleung/Projects/petty/src/styles.css")
                );
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn extracts_read_file_summary_from_sed_command() {
        let input = json!({
            "session_id": "s1",
            "turn_id": "t1",
            "tool_name": "functions.exec_command",
            "arguments": {
                "cmd": "sed -n '1,220p' src-tauri/src/main.rs"
            }
        });
        let mapped = map_hook_input("codex", "PreToolUse", &input).unwrap();
        match mapped {
            HookBridgeMessage::Event(event) => {
                assert_eq!(
                    event.summary.as_deref(),
                    Some("read-file:src-tauri/src/main.rs")
                );
            }
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn extracts_read_file_summary_from_pipeline_command() {
        let input = json!({
            "session_id": "s1",
            "turn_id": "t1",
            "tool_name": "Bash",
            "tool_input": {
                "command": "nl -ba src/pet-models.ts | sed -n '12,22p'"
            }
        });
        let mapped = map_hook_input("codex", "PreToolUse", &input).unwrap();
        match mapped {
            HookBridgeMessage::Event(event) => {
                assert_eq!(
                    event.summary.as_deref(),
                    Some("read-file:src/pet-models.ts")
                );
            }
            _ => panic!("expected event"),
        }
    }
}
