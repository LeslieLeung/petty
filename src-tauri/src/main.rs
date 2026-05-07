use serde::Serialize;
use tauri::{Manager, Runtime};

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "windows")]
mod windows;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
    app_data_dir: Option<String>,
    resource_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenInfo {
    width: f64,
    height: f64,
    scale_factor: f64,
}

/// Logical CSS-pixel work-area rect of a monitor, relative to the pet window's top-left origin.
/// The work area excludes OS-reserved regions such as the macOS menu bar and Dock.
#[derive(Debug, Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    is_primary: bool,
    /// Physical millimeters represented by one webview CSS pixel / Cocoa point.
    /// Present only when the platform can report the monitor's physical size.
    mm_per_css_px: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCursorSnapshot {
    cursor_x: f64,
    cursor_y: f64,
    monitors: Vec<MonitorRect>,
}

#[tauri::command]
fn get_app_paths<R: Runtime>(app: tauri::AppHandle<R>) -> AppPaths {
    let path = app.path();
    AppPaths {
        app_data_dir: path.app_data_dir().ok().map(|p| p.display().to_string()),
        resource_dir: path.resource_dir().ok().map(|p| p.display().to_string()),
    }
}

#[tauri::command]
fn get_screen_info<R: Runtime>(window: tauri::Window<R>) -> ScreenInfo {
    match window.current_monitor().ok().flatten() {
        Some(monitor) => {
            let size = monitor.size();
            ScreenInfo {
                width: size.width as f64,
                height: size.height as f64,
                scale_factor: monitor.scale_factor(),
            }
        }
        None => ScreenInfo {
            width: 360.0,
            height: 360.0,
            scale_factor: 1.0,
        },
    }
}

/// Returns the active monitor work area as a logical CSS-pixel rect relative to
/// the pet window origin. macOS and Windows keep the overlay fitted to one
/// display at a time to avoid mixed-DPI webview coordinate drift.
#[tauri::command]
fn get_monitors<R: Runtime>(window: tauri::Window<R>) -> Result<Vec<MonitorRect>, String> {
    #[cfg(target_os = "macos")]
    {
        return mac::run_on_main(window, |w| mac::get_monitors_main(w));
    }
    #[cfg(target_os = "windows")]
    {
        return windows::get_monitors(&window);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        get_monitors_fallback(&window)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn get_monitors_fallback<R: Runtime>(
    window: &tauri::Window<R>,
) -> Result<Vec<MonitorRect>, String> {
    let win_pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let primary = window.primary_monitor().ok().flatten();
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    Ok(monitors
        .iter()
        .map(|m| {
            let work_area = m.work_area();
            let mp = work_area.position;
            let ms = work_area.size;
            let is_primary = primary
                .as_ref()
                .map(|p| match (p.name(), m.name()) {
                    (Some(pn), Some(mn)) => pn == mn,
                    _ => p.position() == m.position(),
                })
                .unwrap_or(false);
            MonitorRect {
                x: (mp.x as f64 - win_pos.x as f64) / scale,
                y: (mp.y as f64 - win_pos.y as f64) / scale,
                width: ms.width as f64 / scale,
                height: ms.height as f64 / scale,
                is_primary,
                mm_per_css_px: None,
            }
        })
        .collect())
}

/// Returns the cursor's CSS-pixel position relative to the pet window's top-left.
/// Works even when ignore_cursor_events is true because cursor_position queries the OS directly.
#[tauri::command]
fn get_cursor_window_pos<R: Runtime>(window: tauri::Window<R>) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        mac::run_on_main(window, |w| Ok(mac::get_cursor_window_pos_main(w)))
            .ok()
            .flatten()
    }
    #[cfg(target_os = "windows")]
    {
        windows::get_cursor_window_pos(&window)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let cursor = window.cursor_position().ok()?;
        let win_pos = window.outer_position().ok()?;
        let scale = window.scale_factor().ok()?;
        Some((
            (cursor.x - win_pos.x as f64) / scale,
            (cursor.y - win_pos.y as f64) / scale,
        ))
    }
}

#[tauri::command]
fn show_pet_window<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_pet_window<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Settings")
    .inner_size(580.0, 500.0)
    .min_inner_size(480.0, 360.0)
    .center()
    .resizable(true)
    .decorations(true)
    .always_on_top(false)
    .skip_taskbar(false)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_cursor_ignore<R: Runtime>(window: tauri::Window<R>, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

/// Refit the pet window to its current screen after display arrangement changes.
#[tauri::command]
fn fit_pet_window_to_current_screen<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    #[cfg(target_os = "macos")]
    {
        return mac::fit_window_to_current_screen(&window);
    }
    #[cfg(target_os = "windows")]
    {
        return windows::fit_window_to_current_screen(&window);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        expand_window_to_all_monitors_fallback(&window).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn follow_pet_window_to_cursor_screen<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<HostCursorSnapshot>, String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    #[cfg(target_os = "macos")]
    {
        return mac::follow_window_to_cursor_screen(&window);
    }
    #[cfg(target_os = "windows")]
    {
        return windows::follow_window_to_cursor_screen(&window);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(None)
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("pet") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_decorations(false);
                // Allow the overlay to remain visible across every Space and every display.
                // Without this, macOS (with the default "Displays have separate Spaces" setting)
                // clips the window to whichever display currently owns the active Space, so the
                // pet appears to vanish or snap back when the user drags across screens.
                let _ = window.set_visible_on_all_workspaces(true);
                // Keep the transparent overlay on one display at a time. macOS
                // clips WKWebView-backed windows that visibly span displays when
                // "Displays have separate Spaces" is enabled, so JS moves this
                // window to the cursor's display during drag.
                #[cfg(target_os = "macos")]
                let _ = mac::fit_window_to_current_screen(&window);
                #[cfg(target_os = "windows")]
                let _ = windows::fit_window_to_current_screen(&window);
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                let _ = expand_window_to_all_monitors_fallback(&window);
                // Enable click-through by default; JS disables it when cursor is over the pet.
                let _ = window.set_ignore_cursor_events(true);
                // Open DevTools only when explicitly requested via `npm run tauri:dev-console`.
                #[cfg(debug_assertions)]
                if std::env::var("PETTY_DEVTOOLS").is_ok() {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_paths,
            get_screen_info,
            get_monitors,
            get_cursor_window_pos,
            show_pet_window,
            hide_pet_window,
            open_settings_window,
            set_cursor_ignore,
            fit_pet_window_to_current_screen,
            follow_pet_window_to_cursor_screen,
        ])
        .run(tauri::generate_context!())
        .expect("error while running desktop pet");
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn expand_window_to_all_monitors_fallback<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    let monitors = window.available_monitors()?;
    if monitors.is_empty() {
        return Ok(());
    }
    let min_x = monitors.iter().map(|m| m.position().x).min().unwrap_or(0);
    let min_y = monitors.iter().map(|m| m.position().y).min().unwrap_or(0);
    let max_x = monitors
        .iter()
        .map(|m| m.position().x + m.size().width as i32)
        .max()
        .unwrap_or(1920);
    let max_y = monitors
        .iter()
        .map(|m| m.position().y + m.size().height as i32)
        .max()
        .unwrap_or(1080);
    window.set_position(tauri::PhysicalPosition::new(min_x, min_y))?;
    window.set_size(tauri::PhysicalSize::new(
        (max_x - min_x) as u32,
        (max_y - min_y) as u32,
    ))?;
    Ok(())
}
