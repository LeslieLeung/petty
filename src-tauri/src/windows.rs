//! Windows-specific window/monitor geometry helpers.
//!
//! Keep the transparent WebView2 overlay fitted to one monitor's work area at a
//! time, matching the macOS strategy. This avoids a single webview spanning
//! mixed-DPI displays, where CSS pixels cannot represent every monitor's scale
//! correctly at once.

use std::mem::{size_of, zeroed};

use tauri::Runtime;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateDCW, DeleteDC, GetDeviceCaps, GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow,
    HMONITOR, HORZRES, HORZSIZE, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, VERTRES,
    VERTSIZE,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
};

use crate::{HostCursorSnapshot, MonitorRect};

const MONITORINFOF_PRIMARY: u32 = 1;
const DEFAULT_DPI: f64 = 96.0;

pub struct KeyboardActivityDetector {
    previous_down: [bool; 256],
}

impl KeyboardActivityDetector {
    pub fn new() -> Self {
        Self {
            previous_down: [false; 256],
        }
    }

    pub fn detected(&mut self) -> bool {
        let mut pressed = false;
        for virtual_key in 0x08..=0xfe {
            let is_down = unsafe { GetAsyncKeyState(virtual_key) } as u16 & 0x8000 != 0;
            if is_down && !self.previous_down[virtual_key as usize] {
                pressed = true;
            }
            self.previous_down[virtual_key as usize] = is_down;
        }
        pressed
    }
}

fn hwnd_from_window<R: Runtime>(window: &tauri::Window<R>) -> Result<HWND, String> {
    window.hwnd().map_err(|e| e.to_string())
}

fn monitor_info(hmonitor: HMONITOR) -> Result<MONITORINFOEXW, String> {
    let mut info: MONITORINFOEXW = unsafe { zeroed() };
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    let ok = unsafe { GetMonitorInfoW(hmonitor, &mut info as *mut _ as *mut MONITORINFO) };
    if ok.as_bool() {
        Ok(info)
    } else {
        Err("GetMonitorInfoW failed".to_string())
    }
}

fn rect_width(rect: RECT) -> i32 {
    rect.right - rect.left
}

fn rect_height(rect: RECT) -> i32 {
    rect.bottom - rect.top
}

fn monitor_scale(hmonitor: HMONITOR) -> f64 {
    let mut dpi_x = 0;
    let mut dpi_y = 0;
    let result = unsafe { GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    if result.is_ok() && dpi_x > 0 && dpi_y > 0 {
        ((dpi_x as f64 + dpi_y as f64) / 2.0) / DEFAULT_DPI
    } else {
        1.0
    }
}

fn monitor_mm_per_css_px(info: &MONITORINFOEXW, scale: f64) -> Option<f64> {
    let hdc = unsafe {
        CreateDCW(
            w!("DISPLAY"),
            PCWSTR(info.szDevice.as_ptr()),
            PCWSTR::null(),
            None,
        )
    };
    if hdc.is_invalid() {
        return None;
    }

    let horz_mm = unsafe { GetDeviceCaps(Some(hdc), HORZSIZE) };
    let vert_mm = unsafe { GetDeviceCaps(Some(hdc), VERTSIZE) };
    let horz_px = unsafe { GetDeviceCaps(Some(hdc), HORZRES) };
    let vert_px = unsafe { GetDeviceCaps(Some(hdc), VERTRES) };
    let _ = unsafe { DeleteDC(hdc) };

    if horz_mm <= 0 || vert_mm <= 0 || horz_px <= 0 || vert_px <= 0 || scale <= 0.0 {
        return None;
    }

    let x = horz_mm as f64 / (horz_px as f64 / scale);
    let y = vert_mm as f64 / (vert_px as f64 / scale);
    if x.is_finite() && y.is_finite() && x > 0.0 && y > 0.0 {
        Some((x + y) / 2.0)
    } else {
        None
    }
}

fn monitor_rect_for_window<R: Runtime>(
    window: &tauri::Window<R>,
    hmonitor: HMONITOR,
) -> Result<MonitorRect, String> {
    let info = monitor_info(hmonitor)?;
    let win_pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale = monitor_scale(hmonitor);
    let work = info.monitorInfo.rcWork;

    Ok(MonitorRect {
        x: (work.left as f64 - win_pos.x as f64) / scale,
        y: (work.top as f64 - win_pos.y as f64) / scale,
        width: rect_width(work) as f64 / scale,
        height: rect_height(work) as f64 / scale,
        is_primary: (info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0,
        mm_per_css_px: monitor_mm_per_css_px(&info, scale),
    })
}

fn set_window_to_monitor_workarea(hwnd: HWND, hmonitor: HMONITOR) -> Result<(), String> {
    let info = monitor_info(hmonitor)?;
    let work = info.monitorInfo.rcWork;
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            work.left,
            work.top,
            rect_width(work),
            rect_height(work),
            SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
    }
    .map_err(|e| e.to_string())
}

fn cursor_pos() -> Result<POINT, String> {
    let mut point = POINT { x: 0, y: 0 };
    unsafe { GetCursorPos(&mut point) }.map_err(|e| e.to_string())?;
    Ok(point)
}

fn cursor_snapshot<R: Runtime>(window: &tauri::Window<R>) -> Result<HostCursorSnapshot, String> {
    let (cursor_x, cursor_y) =
        get_cursor_window_pos(window).ok_or_else(|| "cursor unavailable".to_string())?;
    let monitors = get_monitors(window)?;
    Ok(HostCursorSnapshot {
        cursor_x,
        cursor_y,
        monitors,
    })
}

pub fn get_monitors<R: Runtime>(window: &tauri::Window<R>) -> Result<Vec<MonitorRect>, String> {
    let hwnd = hwnd_from_window(window)?;
    let hmonitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    Ok(vec![monitor_rect_for_window(window, hmonitor)?])
}

pub fn get_cursor_window_pos<R: Runtime>(window: &tauri::Window<R>) -> Option<(f64, f64)> {
    let hwnd = hwnd_from_window(window).ok()?;
    if hwnd.0.is_null() {
        return None;
    }
    let cursor = cursor_pos().ok()?;
    let hmonitor = unsafe { MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST) };
    let scale = monitor_scale(hmonitor);
    let win_pos = window.outer_position().ok()?;

    Some((
        (cursor.x as f64 - win_pos.x as f64) / scale,
        (cursor.y as f64 - win_pos.y as f64) / scale,
    ))
}

pub fn fit_window_to_current_screen<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let hmonitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    set_window_to_monitor_workarea(hwnd, hmonitor)
}

pub fn follow_window_to_cursor_screen<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<Option<HostCursorSnapshot>, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let cursor = cursor_pos()?;
    let hmonitor = unsafe { MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST) };
    set_window_to_monitor_workarea(hwnd, hmonitor)?;

    let win_clone: tauri::Window<R> = window.as_ref().window();
    Ok(Some(cursor_snapshot(&win_clone)?))
}
