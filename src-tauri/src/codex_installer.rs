use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const START_MARKER: &str = "# >>> Petty Codex hooks >>>";
const END_MARKER: &str = "# <<< Petty Codex hooks <<<";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexIntegrationStatus {
    pub enabled: bool,
    pub config_path: String,
    pub hook_binary_path: String,
    pub has_feature_flag: bool,
    pub has_petty_block: bool,
    pub message: String,
}

pub fn status() -> CodexIntegrationStatus {
    let config_path = codex_config_path();
    let hook_binary_path = hook_binary_path();
    let config = fs::read_to_string(&config_path).unwrap_or_default();
    let has_feature_flag = has_hooks_feature(&config);
    let has_petty_block = config.contains(START_MARKER) && config.contains(END_MARKER);
    CodexIntegrationStatus {
        enabled: has_feature_flag && has_petty_block,
        config_path: config_path.display().to_string(),
        hook_binary_path: hook_binary_path.display().to_string(),
        has_feature_flag,
        has_petty_block,
        message: if has_feature_flag && has_petty_block {
            "Codex integration is enabled.".to_string()
        } else {
            "Codex integration is not enabled.".to_string()
        },
    }
}

pub fn install() -> Result<CodexIntegrationStatus, String> {
    let config_path = codex_config_path();
    let hook_binary_path = hook_binary_path();
    ensure_hook_binary_exists(&hook_binary_path)?;
    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    backup_config(&config_path, &existing)?;
    let without_block = remove_petty_block(&existing);
    let with_feature = ensure_feature_flag(&without_block);
    let next = append_petty_block(&with_feature, &hook_binary_path);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&config_path, next).map_err(|error| error.to_string())?;
    Ok(status())
}

pub fn uninstall() -> Result<CodexIntegrationStatus, String> {
    let config_path = codex_config_path();
    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    backup_config(&config_path, &existing)?;
    let next = remove_petty_block(&existing);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&config_path, next).map_err(|error| error.to_string())?;
    Ok(status())
}

fn codex_config_path() -> PathBuf {
    if let Ok(home) = env::var("CODEX_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join("config.toml");
        }
    }
    home_dir().join(".codex").join("config.toml")
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn hook_binary_path() -> PathBuf {
    if let Ok(path) = env::var("PETTY_AGENT_HOOK_BIN") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }

    let mut current = env::current_exe().unwrap_or_else(|_| PathBuf::from("petty-agent-hook"));
    current.set_file_name(hook_binary_name());
    current
}

fn hook_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "petty-agent-hook.exe"
    } else {
        "petty-agent-hook"
    }
}

fn ensure_hook_binary_exists(path: &Path) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!(
            "petty-agent-hook binary was not found at {}",
            path.display()
        ))
    }
}

fn backup_config(path: &Path, content: &str) -> Result<(), String> {
    if content.is_empty() {
        return Ok(());
    }
    let backup_path = path.with_extension(format!(
        "toml.petty-backup-{}",
        crate::agent_protocol::now_millis()
    ));
    fs::write(backup_path, content).map_err(|error| error.to_string())
}

fn has_hooks_feature(config: &str) -> bool {
    let mut in_features = false;
    for raw_line in config.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') {
            in_features = line == "[features]";
            continue;
        }
        if in_features && feature_key_is(line, "hooks") {
            return line.contains("true");
        }
    }
    false
}

fn ensure_feature_flag(config: &str) -> String {
    let mut lines: Vec<String> = config.lines().map(|line| line.to_string()).collect();
    let mut features_start = None;
    let mut features_end = lines.len();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            if features_start.is_some() {
                features_end = index;
                break;
            }
            if trimmed == "[features]" {
                features_start = Some(index);
            }
        }
    }

    if let Some(start) = features_start {
        for line in lines.iter_mut().take(features_end).skip(start + 1) {
            let trimmed = line.trim_start();
            if feature_key_is(trimmed, "hooks") || feature_key_is(trimmed, "codex_hooks") {
                *line = "hooks = true".to_string();
                return finish_lines(lines);
            }
        }
        lines.insert(start + 1, "hooks = true".to_string());
        return finish_lines(lines);
    }

    if !lines.is_empty() && !lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.push(String::new());
    }
    lines.push("[features]".to_string());
    lines.push("hooks = true".to_string());
    finish_lines(lines)
}

fn feature_key_is(line: &str, expected_key: &str) -> bool {
    line.split_once('=')
        .map(|(key, _)| key.trim() == expected_key)
        .unwrap_or(false)
}

fn append_petty_block(config: &str, hook_binary_path: &Path) -> String {
    let command = shell_command(hook_binary_path);
    let mut output = config.trim_end().to_string();
    if !output.is_empty() {
        output.push_str("\n\n");
    }
    output.push_str(START_MARKER);
    output.push('\n');
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PermissionRequest",
        "Stop",
    ] {
        output.push_str(&format!(
            r#"
[[hooks.{event}]]
matcher = ".*"

[[hooks.{event}.hooks]]
type = "command"
command = "{command} codex {event}"
"#
        ));
        if event == "PermissionRequest" {
            output.push_str("timeout = 25\n");
        }
    }
    output.push_str(END_MARKER);
    output.push('\n');
    output
}

fn shell_command(path: &Path) -> String {
    let escaped = path
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\\\"{escaped}\\\"")
}

fn remove_petty_block(config: &str) -> String {
    let mut output = Vec::new();
    let mut skipping = false;
    for line in config.lines() {
        if line.trim() == START_MARKER {
            skipping = true;
            continue;
        }
        if line.trim() == END_MARKER {
            skipping = false;
            continue;
        }
        if !skipping {
            output.push(line.to_string());
        }
    }
    finish_lines(output)
}

fn finish_lines(lines: Vec<String>) -> String {
    let mut text = lines.join("\n");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_feature_flag_to_existing_config() {
        let config = r#"model = "gpt-5"

[projects."/tmp"]
trust_level = "trusted"
"#;
        let updated = ensure_feature_flag(config);
        assert!(updated.contains("[features]\nhooks = true"));
        assert!(updated.contains("[projects.\"/tmp\"]"));
    }

    #[test]
    fn migrates_deprecated_codex_hooks_feature_flag() {
        let updated = ensure_feature_flag("[features]\ncodex_hooks = true\n");
        assert!(updated.contains("[features]\nhooks = true"));
        assert!(!updated.contains("codex_hooks"));
    }

    #[test]
    fn removes_only_petty_block() {
        let config = format!("a = 1\n\n{START_MARKER}\nmanaged = true\n{END_MARKER}\n\nb = 2\n");
        let updated = remove_petty_block(&config);
        assert!(updated.contains("a = 1"));
        assert!(updated.contains("b = 2"));
        assert!(!updated.contains("managed = true"));
    }
}
