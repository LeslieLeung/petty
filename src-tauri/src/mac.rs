//! macOS-specific window/monitor geometry helpers.
//!
//! All calculations live in NSScreen Cocoa coordinates (Y-UP, logical points,
//! origin at the bottom-left of the screen marked as primary in System Prefs).
//! This avoids tao's per-monitor "physical" mixed-scale issue, which can place
//! a screen's reported position outside the window's bounding box when the
//! displays have different DPIs or unaligned heights.
//!
//! Webview CSS pixels equal logical points (1:1 with NSScreen frames),
//! independent of `devicePixelRatio`, so we return raw points to the JS side.
//!
//! ## Multi-monitor window spanning
//!
//! macOS (with "Displays have separate Spaces" ON, the default since 10.9) runs
//! `-[NSWindow constrainFrameRect:toScreen:]` whenever `setFrame:display:` is
//! called, silently clipping the window's frame to the single display that
//! currently "owns" it.  Even with `NSWindowCollectionBehaviorCanJoinAllSpaces`
//! the window appears in every Space, but its rendered canvas covers only one
//! physical display — making the pet invisible the moment it crosses a screen
//! boundary.
//!
//! The most reliable strategy is to keep the WKWebView-backed pet window on a
//! single display at a time, then move that native window to the cursor's
//! current display while dragging. This avoids relying on a single rendered
//! surface spanning multiple independent Spaces.

use std::ffi::c_char;
use std::sync::Once;

use objc2::rc::Retained;
use objc2::{msg_send, MainThreadMarker};
use objc2_app_kit::{NSColor, NSMainMenuWindowLevel, NSScreen, NSWindow};
use objc2_foundation::{NSPoint, NSRect};
use std::sync::mpsc;
use tauri::Runtime;

use crate::{HostCursorSnapshot, MonitorRect};

type CGDirectDisplayID = u32;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGDisplayScreenSize(display: CGDirectDisplayID) -> CGSize;
}

// ── Multi-monitor window patch ────────────────────────────────────────────────

// Stable Objective-C runtime C functions used for the multi-monitor patch.
extern "C" {
    fn object_getClass(obj: *const ()) -> *const ();
    fn objc_getClass(name: *const c_char) -> *const ();
    fn class_getInstanceMethod(cls: *const (), sel: *const ()) -> *const ();
    fn method_getTypeEncoding(m: *const ()) -> *const c_char;
    fn class_replaceMethod(
        cls: *const (),
        sel: *const (),
        imp: *const (),
        types: *const c_char,
    ) -> *const ();
    fn sel_registerName(name: *const c_char) -> *const ();
}

/// ObjC IMP that returns `frame_rect` unchanged, bypassing macOS's per-display
/// frame constraint.  The calling convention matches ObjC method dispatch on
/// both arm64 (register returns) and x86_64 (sret for structs > 16 bytes).
extern "C" fn constrain_frame_rect_passthrough(
    _this: *mut (),
    _sel: *const (),
    frame_rect: NSRect,
    _screen: *const (),
) -> NSRect {
    frame_rect
}

static MULTI_MONITOR_PATCH: Once = Once::new();

/// Override `-[NSWindow constrainFrameRect:toScreen:]` on the pet window's ObjC
/// class so that `setFrame:display:` with a bounding-box spanning all monitors
/// is never clipped to one display.
///
/// Uses `class_replaceMethod` to modify the class in-place.  Tauri creates a
/// private NSWindow subclass for the webview window; the replacement is scoped
/// to that subclass, so unrelated windows are not affected.
///
/// **Must be called on the main thread**, and before the first `setFrame:` call.
fn patch_window_for_multi_monitor(ns_window: &NSWindow) {
    MULTI_MONITOR_PATCH.call_once(|| unsafe {
        let sel = sel_registerName(b"constrainFrameRect:toScreen:\0".as_ptr() as *const c_char);

        // Tauri may wrap NSWindow in its own subclass — target that subclass
        // specifically so the patch is as narrow as possible.
        let win_cls = object_getClass(ns_window as *const NSWindow as *const ());
        if win_cls.is_null() {
            return;
        }

        // Re-use NSWindow's type encoding rather than hard-coding
        // platform-specific struct encodings (arm64 vs x86_64 differ for NSRect).
        let nswindow_cls = objc_getClass(b"NSWindow\0".as_ptr() as *const c_char);
        let encoding: *const c_char = if !nswindow_cls.is_null() {
            let m = class_getInstanceMethod(nswindow_cls, sel);
            if m.is_null() {
                std::ptr::null()
            } else {
                method_getTypeEncoding(m)
            }
        } else {
            std::ptr::null()
        };

        class_replaceMethod(
            win_cls,
            sel,
            constrain_frame_rect_passthrough as *const (),
            encoding,
        );
    });
}

/// Configure the pet overlay as a desktop-wide utility surface. Raising the
/// level is important on macOS 10.9+ because AppKit constrains normal-level
/// borderless windows to the owning display when separate Spaces are enabled.
fn configure_overlay_window(ns_window: &NSWindow) {
    ns_window.setLevel(NSMainMenuWindowLevel);
    ns_window.setOpaque(false);
    ns_window.setHasShadow(false);
    ns_window.setBackgroundColor(Some(&NSColor::clearColor()));
    unsafe {
        let current: u64 = msg_send![ns_window, collectionBehavior];
        let updated = current | 16u64 | 256u64;
        let _: () = msg_send![ns_window, setCollectionBehavior: updated];
    }
}

/// Run `f` on the main thread and block for its result. Required for any
/// access to `NSScreen` / `NSWindow`, which AppKit constrains to the main
/// thread.
pub fn run_on_main<R: Runtime, T, F>(window: tauri::Window<R>, f: F) -> Result<T, String>
where
    F: FnOnce(&tauri::Window<R>) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    let window_for_main = window.clone();
    window
        .run_on_main_thread(move || {
            let result = f(&window_for_main);
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Cast Tauri's opaque `*mut c_void` to a typed `&NSWindow`. Caller MUST be on
/// the main thread.
unsafe fn ns_window_from<R: Runtime>(window: &tauri::Window<R>) -> Option<Retained<NSWindow>> {
    let ptr = window.ns_window().ok()?;
    if ptr.is_null() {
        return None;
    }
    let raw = ptr as *mut NSWindow;
    Some(unsafe { Retained::retain(raw)? })
}

fn monitor_rect_for_visible_frame(
    win_frame: NSRect,
    screen: &NSScreen,
    visible: NSRect,
    is_primary: bool,
) -> MonitorRect {
    let win_top_y = win_frame.origin.y + win_frame.size.height;
    let visible_top_y = visible.origin.y + visible.size.height;
    // Cocoa Y-UP global → window-relative Y-DOWN.
    MonitorRect {
        x: visible.origin.x - win_frame.origin.x,
        y: win_top_y - visible_top_y,
        width: visible.size.width,
        height: visible.size.height,
        is_primary,
        mm_per_css_px: screen_mm_per_css_px(screen),
    }
}

fn screen_mm_per_css_px(screen: &NSScreen) -> Option<f64> {
    let frame = screen.frame();
    if frame.size.width <= 0.0 || frame.size.height <= 0.0 {
        return None;
    }

    let display_id: CGDirectDisplayID = unsafe { msg_send![screen, CGDirectDisplayID] };
    if display_id == 0 {
        return None;
    }

    let physical = unsafe { CGDisplayScreenSize(display_id) };
    if physical.width <= 0.0 || physical.height <= 0.0 {
        return None;
    }

    let x_mm_per_point = physical.width / frame.size.width;
    let y_mm_per_point = physical.height / frame.size.height;
    if x_mm_per_point.is_finite() && y_mm_per_point.is_finite() {
        Some((x_mm_per_point + y_mm_per_point) / 2.0)
    } else {
        None
    }
}

fn screen_is_main(screen: &Retained<NSScreen>, main_screen_ptr: *const NSScreen) -> bool {
    !main_screen_ptr.is_null()
        && std::ptr::eq(Retained::as_ptr(screen) as *const NSScreen, main_screen_ptr)
}

/// Compute the current screen's work-area rect, expressed in window-relative
/// Y-DOWN logical points (= webview CSS pixels). MUST be called on main thread.
///
/// The pet window is intentionally fitted to a single display on macOS. Returning
/// every display here would let the JS runtime snap the pet to a neighboring
/// display's edge while AppKit is still rendering only the current display.
pub fn get_monitors_main<R: Runtime>(
    window: &tauri::Window<R>,
) -> Result<Vec<MonitorRect>, String> {
    let mtm = MainThreadMarker::new().ok_or("get_monitors must run on main thread")?;
    let ns_window = unsafe { ns_window_from(window) }.ok_or("ns_window unavailable")?;
    let win_frame = ns_window.frame();
    let window_center = NSPoint::new(
        win_frame.origin.x + win_frame.size.width / 2.0,
        win_frame.origin.y + win_frame.size.height / 2.0,
    );

    let main_screen = NSScreen::mainScreen(mtm);
    let main_screen_ptr: *const NSScreen = main_screen
        .as_ref()
        .map(|s| Retained::as_ptr(s))
        .unwrap_or(std::ptr::null());

    for screen in NSScreen::screens(mtm).iter() {
        if rect_contains_point(screen.frame(), window_center) {
            return Ok(vec![monitor_rect_for_visible_frame(
                win_frame,
                &screen,
                screen.visibleFrame(),
                screen_is_main(&screen, main_screen_ptr),
            )]);
        }
    }

    screen_for_window(mtm, &ns_window)
        .map(|screen| {
            vec![monitor_rect_for_visible_frame(
                win_frame,
                &screen,
                screen.visibleFrame(),
                false,
            )]
        })
        .ok_or_else(|| "current screen unavailable".to_string())
}

/// Returns cursor's CSS-pixel position relative to the pet window's top-left.
/// MUST be called on main thread.
pub fn get_cursor_window_pos_main<R: Runtime>(window: &tauri::Window<R>) -> Option<(f64, f64)> {
    use objc2_app_kit::NSEvent;
    let ns_window = unsafe { ns_window_from(window) }?;
    let win_frame = ns_window.frame();
    let cursor = NSEvent::mouseLocation();
    let x = cursor.x - win_frame.origin.x;
    let y = (win_frame.origin.y + win_frame.size.height) - cursor.y;
    Some((x, y))
}

fn rect_contains_point(rect: NSRect, point: NSPoint) -> bool {
    point.x >= rect.origin.x
        && point.x < rect.origin.x + rect.size.width
        && point.y >= rect.origin.y
        && point.y < rect.origin.y + rect.size.height
}

fn rect_center_distance(rect: NSRect, point: NSPoint) -> f64 {
    let cx = rect.origin.x + rect.size.width / 2.0;
    let cy = rect.origin.y + rect.size.height / 2.0;
    (point.x - cx).hypot(point.y - cy)
}

fn same_rect(a: NSRect, b: NSRect) -> bool {
    const EPSILON: f64 = 0.5;
    (a.origin.x - b.origin.x).abs() < EPSILON
        && (a.origin.y - b.origin.y).abs() < EPSILON
        && (a.size.width - b.size.width).abs() < EPSILON
        && (a.size.height - b.size.height).abs() < EPSILON
}

fn screen_visible_frame_containing_point(mtm: MainThreadMarker, point: NSPoint) -> Option<NSRect> {
    let screens = NSScreen::screens(mtm);
    let mut nearest: Option<(NSRect, f64)> = None;
    for screen in screens.iter() {
        let frame = screen.frame();
        if rect_contains_point(frame, point) {
            return Some(screen.visibleFrame());
        }
        let distance = rect_center_distance(frame, point);
        if nearest.map(|(_, best)| distance < best).unwrap_or(true) {
            nearest = Some((screen.visibleFrame(), distance));
        }
    }
    nearest.map(|(frame, _)| frame)
}

fn screen_visible_frame_for_window(mtm: MainThreadMarker, ns_window: &NSWindow) -> Option<NSRect> {
    screen_for_window(mtm, ns_window).map(|screen| screen.visibleFrame())
}

fn screen_for_window(mtm: MainThreadMarker, ns_window: &NSWindow) -> Option<Retained<NSScreen>> {
    let window_frame = ns_window.frame();
    let center = NSPoint::new(
        window_frame.origin.x + window_frame.size.width / 2.0,
        window_frame.origin.y + window_frame.size.height / 2.0,
    );
    screen_containing_point(mtm, center)
}

fn screen_containing_point(mtm: MainThreadMarker, point: NSPoint) -> Option<Retained<NSScreen>> {
    let screens = NSScreen::screens(mtm);
    let mut nearest: Option<(Retained<NSScreen>, f64)> = None;
    for screen in screens.iter() {
        let frame = screen.frame();
        if rect_contains_point(frame, point) {
            return Some(screen);
        }
        let distance = rect_center_distance(frame, point);
        if nearest.as_ref().map(|(_, best)| distance < *best).unwrap_or(true) {
            nearest = Some((screen, distance));
        }
    }
    nearest.map(|(screen, _)| screen)
}

fn set_window_frame_if_needed(ns_window: &NSWindow, frame: NSRect) {
    if !same_rect(ns_window.frame(), frame) {
        ns_window.setFrame_display(frame, true);
    }
}

fn cursor_snapshot_main<R: Runtime>(
    window: &tauri::Window<R>,
) -> Result<HostCursorSnapshot, String> {
    let (cursor_x, cursor_y) =
        get_cursor_window_pos_main(window).ok_or_else(|| "cursor unavailable".to_string())?;
    let monitors = get_monitors_main(window)?;
    Ok(HostCursorSnapshot {
        cursor_x,
        cursor_y,
        monitors,
    })
}

/// Fit the pet overlay to the display that currently owns the window. This is
/// used at startup and when the monitor layout changes outside a drag.
pub fn fit_window_to_current_screen<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let win_clone: tauri::Window<R> = window.as_ref().window();
    run_on_main(win_clone, |w| {
        let mtm = MainThreadMarker::new().ok_or("fit must run on main thread")?;
        let ns_window = unsafe { ns_window_from(w) }.ok_or("ns_window unavailable")?;

        patch_window_for_multi_monitor(&ns_window);
        configure_overlay_window(&ns_window);

        if let Some(frame) = screen_visible_frame_for_window(mtm, &ns_window) {
            set_window_frame_if_needed(&ns_window, frame);
        }
        Ok(())
    })
}

/// During drag, move the native overlay to whichever display contains the
/// cursor and return cursor/monitor coordinates relative to the new window.
pub fn follow_window_to_cursor_screen<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<Option<HostCursorSnapshot>, String> {
    let win_clone: tauri::Window<R> = window.as_ref().window();
    run_on_main(win_clone, |w| {
        use objc2_app_kit::NSEvent;

        let mtm = MainThreadMarker::new().ok_or("follow must run on main thread")?;
        let ns_window = unsafe { ns_window_from(w) }.ok_or("ns_window unavailable")?;
        let cursor = NSEvent::mouseLocation();

        patch_window_for_multi_monitor(&ns_window);
        configure_overlay_window(&ns_window);

        if let Some(frame) = screen_visible_frame_containing_point(mtm, cursor) {
            set_window_frame_if_needed(&ns_window, frame);
        }

        Ok(Some(cursor_snapshot_main(w)?))
    })
}
