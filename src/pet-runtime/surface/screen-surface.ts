import type { SurfaceKind } from '../resource/runtime-manifest'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PetBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapResult {
  x: number
  y: number
  surface: SurfaceKind
}

export interface Point {
  x: number
  y: number
}

const DEFAULT_SPAWN_X_RATIO = 0.72
const DEFAULT_SPAWN_MARGIN_PX = 32
const DEFAULT_SPAWN_BOTTOM_INSET_PX = 96

export function viewportWorkarea(): Rect {
  return {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

/**
 * Pick a conservative first-run position inside the OS work area.
 * The pet starts off the exact bottom edge so a visible or auto-hidden Dock is less likely to cover it.
 */
export function defaultPetSpawnPoint(workarea: Rect, petSize: { width: number; height: number }): Point {
  const halfWidth = petSize.width / 2
  const minX = workarea.x + DEFAULT_SPAWN_MARGIN_PX + halfWidth
  const maxX = workarea.x + workarea.width - DEFAULT_SPAWN_MARGIN_PX - halfWidth
  const minY = workarea.y + DEFAULT_SPAWN_MARGIN_PX + petSize.height
  const maxY = workarea.y + workarea.height - DEFAULT_SPAWN_MARGIN_PX

  return {
    x: clamp(workarea.x + workarea.width * DEFAULT_SPAWN_X_RATIO, minX, maxX),
    y: clamp(workarea.y + workarea.height - DEFAULT_SPAWN_BOTTOM_INSET_PX, minY, maxY),
  }
}

/**
 * Multi-monitor aware snap: finds the monitor nearest to the pet, then delegates
 * to snapToScreenEdge using that monitor's bounds as the workarea.
 * Falls back to the full viewport if no monitors are provided.
 */
export function snapToMonitors(bounds: PetBounds, monitors: Rect[], snapDistancePx: number): SnapResult {
  if (monitors.length === 0) return snapToScreenEdge(bounds, viewportWorkarea(), snapDistancePx)

  return snapToScreenEdge(bounds, nearestMonitorToBounds(bounds, monitors), snapDistancePx)
}

export function clampBoundsToMonitors(bounds: PetBounds, monitors: Rect[], anchor?: Point): PetBounds {
  if (monitors.length === 0) return clampBoundsToWorkarea(bounds, viewportWorkarea())

  const workarea = anchor
    ? monitorContainingPoint(monitors, anchor) ?? nearestMonitorToBounds(bounds, monitors)
    : nearestMonitorToBounds(bounds, monitors)
  return clampBoundsToWorkarea(bounds, workarea)
}

export function clampBoundsToWorkarea(bounds: PetBounds, workarea: Rect): PetBounds {
  return {
    ...bounds,
    x: clamp(bounds.x, workarea.x, workarea.x + workarea.width - bounds.width),
    y: clamp(bounds.y, workarea.y, workarea.y + workarea.height - bounds.height),
  }
}

export function monitorContainingPoint(monitors: Rect[], point: Point): Rect | undefined {
  return monitors.find((mon) => (
    point.x >= mon.x &&
    point.x < mon.x + mon.width &&
    point.y >= mon.y &&
    point.y < mon.y + mon.height
  ))
}

function nearestMonitorToBounds(bounds: PetBounds, monitors: Rect[]): Rect {
  const petCx = bounds.x + bounds.width / 2
  const petCy = bounds.y + bounds.height / 2

  // Find the monitor whose center is nearest to the pet's center
  return monitors.reduce((best, mon) => {
    const monCx = mon.x + mon.width / 2
    const monCy = mon.y + mon.height / 2
    const d = Math.hypot(petCx - monCx, petCy - monCy)
    const bd = Math.hypot(petCx - (best.x + best.width / 2), petCy - (best.y + best.height / 2))
    return d < bd ? mon : best
  }, monitors[0])
}

export function snapToScreenEdge(bounds: PetBounds, workarea: Rect, snapDistancePx: number): SnapResult {
  const leftDistance = Math.abs(bounds.x - workarea.x)
  const rightDistance = Math.abs(workarea.x + workarea.width - (bounds.x + bounds.width))
  const topDistance = Math.abs(bounds.y - workarea.y)
  const bottomDistance = Math.abs(workarea.y + workarea.height - (bounds.y + bounds.height))

  const nearest = [
    { surface: 'screen-bottom' as const, distance: bottomDistance },
    { surface: 'screen-left' as const, distance: leftDistance },
    { surface: 'screen-right' as const, distance: rightDistance },
    { surface: 'screen-top' as const, distance: topDistance },
  ].sort((a, b) => a.distance - b.distance)[0]

  const clamped = clampBoundsToWorkarea(bounds, workarea)

  if (nearest.distance > snapDistancePx) {
    return { x: clamped.x, y: clamped.y, surface: 'none' }
  }

  switch (nearest.surface) {
    case 'screen-bottom':
      return { x: clamped.x, y: workarea.y + workarea.height - bounds.height, surface: nearest.surface }
    case 'screen-left':
      return { x: workarea.x, y: clamped.y, surface: nearest.surface }
    case 'screen-right':
      return { x: workarea.x + workarea.width - bounds.width, y: clamped.y, surface: nearest.surface }
    case 'screen-top':
      return { x: clamped.x, y: workarea.y, surface: nearest.surface }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2
  return Math.min(Math.max(value, min), max)
}
