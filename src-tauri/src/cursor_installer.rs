use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const PETTY_HOOK_MARKER: &str = "petty-agent-hook";

const HOOK_EVENTS: &[&str] = &[
    "sessionStart",
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "stop",
    "sessionEnd",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorIntegrationStatus {
    pub enabled: bool,
    pub config_path: String,
    pub hook_binary_path: String,
    pub has_petty_hooks: bool,
    pub message: String,
}

pub fn status() -> CursorIntegrationStatus {
    let config_path = cursor_hooks_config_path();
    let hook_binary_path = hook_binary_path();
    let has_petty_hooks = read_hooks_json(&config_path)
        .map(|json| has_petty_hook_entries(&json))
        .unwrap_or(false);
    CursorIntegrationStatus {
        enabled: has_petty_hooks,
        config_path: config_path.display().to_string(),
        hook_binary_path: hook_binary_path.display().to_string(),
        has_petty_hooks,
        message: if has_petty_hooks {
            "Cursor integration is enabled.".to_string()
        } else {
            "Cursor integration is not enabled.".to_string()
        },
    }
}

pub fn install() -> Result<CursorIntegrationStatus, String> {
    let config_path = cursor_hooks_config_path();
    let hook_binary_path = hook_binary_path();
    ensure_hook_binary_exists(&hook_binary_path)?;

    let (existing_json, existing_content) = read_existing_hooks_json(&config_path)?;
    backup_config(&config_path, existing_content.as_deref())?;

    let updated = upsert_petty_hooks(existing_json, &hook_binary_path);

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
    fs::write(&config_path, serialized).map_err(|e| e.to_string())?;

    Ok(status())
}

pub fn uninstall() -> Result<CursorIntegrationStatus, String> {
    let config_path = cursor_hooks_config_path();
    let (existing_json, Some(existing_content)) = read_existing_hooks_json(&config_path)? else {
        return Ok(status());
    };
    if existing_content.is_empty() {
        return Ok(status());
    }
    backup_config(&config_path, Some(&existing_content))?;

    let updated = remove_petty_hooks(existing_json);

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
    fs::write(&config_path, serialized).map_err(|e| e.to_string())?;

    Ok(status())
}

fn read_existing_hooks_json(path: &Path) -> Result<(Value, Option<String>), String> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let json = serde_json::from_str(&content).map_err(|error| {
                format!(
                    "Cursor hooks config at {} is not valid JSON: {error}",
                    path.display()
                )
            })?;
            Ok((json, Some(content)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok((json!({"version": 1, "hooks": {}}), None))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn cursor_hooks_config_path() -> PathBuf {
    if let Ok(home) = env::var("CURSOR_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home).join("hooks.json");
        }
    }
    home_dir().join(".cursor").join("hooks.json")
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

fn read_hooks_json(path: &Path) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn backup_config(path: &Path, content: Option<&str>) -> Result<(), String> {
    let Some(content) = content else {
        return Ok(());
    };
    if content.is_empty() {
        return Ok(());
    }
    let backup_path = path.with_extension(format!(
        "json.petty-backup-{}",
        crate::agent_protocol::now_millis()
    ));
    fs::write(backup_path, content).map_err(|e| e.to_string())
}

fn has_petty_hook_entries(json: &Value) -> bool {
    let Some(hooks) = json.get("hooks").and_then(Value::as_object) else {
        return false;
    };
    for entries in hooks.values() {
        if let Some(arr) = entries.as_array() {
            for entry in arr {
                if entry_is_petty(entry) {
                    return true;
                }
            }
        }
    }
    false
}

fn entry_is_petty(entry: &Value) -> bool {
    entry
        .get("command")
        .and_then(Value::as_str)
        .map(|cmd| cmd.contains(PETTY_HOOK_MARKER))
        .unwrap_or(false)
}

fn shell_command(path: &Path, event: &str) -> String {
    let escaped = path
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\"{escaped}\" cursor {event}")
}

fn upsert_petty_hooks(mut json: Value, hook_binary_path: &Path) -> Value {
    let hooks = json
        .as_object_mut()
        .and_then(|obj| {
            if !obj.contains_key("hooks") {
                obj.insert("hooks".to_string(), json!({}));
            }
            obj.get_mut("hooks")
        })
        .and_then(Value::as_object_mut);

    let Some(hooks_map) = hooks else {
        return json;
    };

    for event in HOOK_EVENTS {
        let command = shell_command(hook_binary_path, event);
        let new_entry = json!({ "command": command });

        let arr = hooks_map
            .entry(event.to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut();

        if let Some(arr) = arr {
            arr.retain(|e| !entry_is_petty(e));
            arr.push(new_entry);
        }
    }

    json
}

fn remove_petty_hooks(mut json: Value) -> Value {
    let hooks = json
        .as_object_mut()
        .and_then(|obj| obj.get_mut("hooks"))
        .and_then(Value::as_object_mut);

    if let Some(hooks_map) = hooks {
        for arr in hooks_map.values_mut() {
            if let Some(entries) = arr.as_array_mut() {
                entries.retain(|e| !entry_is_petty(e));
            }
        }
    }

    json
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn detects_petty_hooks() {
        let json = json!({
            "version": 1,
            "hooks": {
                "sessionStart": [{ "command": "\"/usr/local/bin/petty-agent-hook\" cursor sessionStart" }]
            }
        });
        assert!(has_petty_hook_entries(&json));
    }

    #[test]
    fn detects_no_petty_hooks_in_empty() {
        let json = json!({ "version": 1, "hooks": {} });
        assert!(!has_petty_hook_entries(&json));
    }

    #[test]
    fn upsert_adds_all_events() {
        let json = json!({ "version": 1, "hooks": {} });
        let path = PathBuf::from("/usr/local/bin/petty-agent-hook");
        let result = upsert_petty_hooks(json, &path);
        let hooks = result.get("hooks").unwrap().as_object().unwrap();
        for event in HOOK_EVENTS {
            assert!(hooks.contains_key(*event), "missing hook: {event}");
        }
        assert!(has_petty_hook_entries(&result));
    }

    #[test]
    fn upsert_does_not_duplicate() {
        let json = json!({ "version": 1, "hooks": {} });
        let path = PathBuf::from("/usr/local/bin/petty-agent-hook");
        let once = upsert_petty_hooks(json, &path);
        let twice = upsert_petty_hooks(once, &path);
        let hooks = twice.get("hooks").unwrap().as_object().unwrap();
        for event in HOOK_EVENTS {
            let entries = hooks.get(*event).unwrap().as_array().unwrap();
            let petty_count = entries.iter().filter(|e| entry_is_petty(e)).count();
            assert_eq!(petty_count, 1, "duplicate entry for {event}");
        }
    }

    #[test]
    fn upsert_preserves_other_hooks() {
        let json = json!({
            "version": 1,
            "hooks": {
                "afterFileEdit": [{ "command": "./format.sh" }]
            }
        });
        let path = PathBuf::from("/usr/local/bin/petty-agent-hook");
        let result = upsert_petty_hooks(json, &path);
        let other = result["hooks"]["afterFileEdit"].as_array().unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0]["command"].as_str().unwrap(), "./format.sh");
    }

    #[test]
    fn remove_strips_only_petty_entries() {
        let json = json!({
            "version": 1,
            "hooks": {
                "sessionStart": [
                    { "command": "\"/usr/local/bin/petty-agent-hook\" cursor sessionStart" },
                    { "command": "./other.sh" }
                ]
            }
        });
        let result = remove_petty_hooks(json);
        let entries = result["hooks"]["sessionStart"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["command"].as_str().unwrap(), "./other.sh");
    }

    #[test]
    fn read_existing_rejects_invalid_json() {
        let dir = test_dir("invalid-json");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hooks.json");
        fs::write(&path, "{not json").unwrap();

        let error = read_existing_hooks_json(&path).unwrap_err();

        assert!(error.contains("is not valid JSON"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{not json");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn backup_config_preserves_raw_content() {
        let dir = test_dir("raw-backup");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hooks.json");
        fs::write(&path, "{not json").unwrap();

        backup_config(&path, Some("{not json")).unwrap();

        let backup = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .is_some_and(|ext| ext.to_string_lossy().contains("petty-backup"))
            })
            .unwrap();
        assert_eq!(fs::read_to_string(backup).unwrap(), "{not json");
        fs::remove_dir_all(dir).unwrap();
    }

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "petty-cursor-installer-{name}-{}-{}",
            std::process::id(),
            crate::agent_protocol::now_millis()
        ))
    }
}
