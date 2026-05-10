use petty_agent::agent_bridge::{post_json, read_bridge_config};
use petty_agent::agent_hook::{codex_stdout_for_decision, map_hook_input, HookBridgeMessage};
use petty_agent::agent_protocol::{
    bridge_config_path, ApprovalDecision, ApprovalDecisionResponse, DEFAULT_EVENT_TIMEOUT_MS,
};
use serde_json::Value;
use std::io::{self, Read, Write};
use std::time::Duration;

fn main() {
    let exit_code = run();
    std::process::exit(exit_code);
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    let agent = args.get(1).map(String::as_str).unwrap_or("");
    let hook_event = args.get(2).map(String::as_str).unwrap_or("");
    if agent.is_empty() || hook_event.is_empty() {
        return 0;
    }

    let mut stdin = String::new();
    if io::stdin().read_to_string(&mut stdin).is_err() {
        return 0;
    }
    let input: Value = serde_json::from_str(&stdin).unwrap_or(Value::Null);
    let mapped = match map_hook_input(agent, hook_event, &input) {
        Ok(mapped) => mapped,
        Err(_) => return 0,
    };
    let config = match read_bridge_config(&bridge_config_path()) {
        Ok(config) => config,
        Err(_) => {
            write_fallback(agent, hook_event);
            return 0;
        }
    };

    match mapped {
        HookBridgeMessage::Event(event) => {
            let _ = post_json(
                &config,
                "/v1/agents/events",
                &event,
                Duration::from_millis(DEFAULT_EVENT_TIMEOUT_MS),
            );
        }
        HookBridgeMessage::Approval(approval) => {
            let timeout = Duration::from_millis(approval.timeout_ms.saturating_add(1_000));
            let decision = post_json(&config, "/v1/agents/approval-requests", &approval, timeout)
                .ok()
                .and_then(|value| serde_json::from_value::<ApprovalDecisionResponse>(value).ok())
                .map(|response| response.decision)
                .unwrap_or(ApprovalDecision::Fallback);
            write_decision(agent, decision);
        }
        HookBridgeMessage::None => write_fallback(agent, hook_event),
    }

    0
}

fn write_decision(agent: &str, decision: ApprovalDecision) {
    if agent == "codex" {
        let _ = io::stdout().write_all(codex_stdout_for_decision(decision).as_bytes());
    }
}

fn write_fallback(agent: &str, hook_event: &str) {
    if agent == "codex" && hook_event == "PermissionRequest" {
        let _ = io::stdout()
            .write_all(codex_stdout_for_decision(ApprovalDecision::Fallback).as_bytes());
    }
}
