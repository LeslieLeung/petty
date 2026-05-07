import type { RuntimeClip, RuntimeManifest } from '../resource/runtime-manifest'

export type ControlState = 'booting' | 'loading' | 'idle' | 'autonomous' | 'interacting' | 'dragging' | 'recovering' | 'error'

export interface StateSnapshot {
  controlState: ControlState
  clipKey: string
  reason: string
}

export class PetStateMachine {
  private controlState: ControlState = 'booting'
  private clipKey: string
  private startedAt = performance.now()
  private reason = 'boot'

  constructor(private readonly manifest: RuntimeManifest) {
    this.clipKey = manifest.meta.defaultState
  }

  get snapshot(): StateSnapshot {
    return {
      controlState: this.controlState,
      clipKey: this.clipKey,
      reason: this.reason,
    }
  }

  get currentClip(): RuntimeClip {
    return this.manifest.clips[this.clipKey] ?? this.manifest.clips[this.manifest.meta.defaultState]
  }

  setReady(): string {
    return this.transition('idle', this.manifest.meta.defaultState, 'ready', true)
  }

  requestInteraction(candidates: string[], reason: string): string {
    const clip = this.pickFirstAvailable(candidates)
    return this.transition('interacting', clip, reason, true)
  }

  requestAutonomous(candidates: string[], reason: string): string {
    if (!this.canInterruptForAutonomous()) return this.clipKey
    const clip = this.pickRandomAvailable(candidates)
    return this.transition('autonomous', clip, reason, false)
  }

  startDrag(): string {
    return this.transition('dragging', this.pickFirstAvailable(this.manifest.interactions.dragStart ?? ['idle']), 'drag-start', true)
  }

  recover(candidates?: string[]): string {
    return this.transition('recovering', this.pickFirstAvailable(candidates ?? this.manifest.interactions.dragEnd ?? ['idle']), 'recover', true)
  }

  settle(): string {
    return this.transition('idle', this.manifest.meta.defaultState, 'settle', true)
  }

  completeClip(): string {
    const nextState = this.currentClip.nextState
    if (nextState && this.manifest.clips[nextState]) {
      return this.transition('idle', nextState, 'clip-next-state', true)
    }
    if (!this.currentClip.loop) return this.settle()
    return this.clipKey
  }

  markError(): void {
    this.controlState = 'error'
    this.reason = 'runtime-error'
  }

  private transition(controlState: ControlState, clipKey: string, reason: string, force: boolean): string {
    if (!force && !this.canInterrupt()) return this.clipKey
    this.controlState = controlState
    this.clipKey = clipKey
    this.startedAt = performance.now()
    this.reason = reason
    return clipKey
  }

  private canInterruptForAutonomous(): boolean {
    return this.controlState === 'idle' || this.controlState === 'autonomous'
  }

  private canInterrupt(): boolean {
    const elapsed = performance.now() - this.startedAt
    const minDuration = this.currentClip.minDurationMs ?? 0
    return this.currentClip.interruptible && elapsed >= minDuration
  }

  private pickFirstAvailable(candidates: string[]): string {
    return candidates.find((key) => this.manifest.clips[key]) ?? this.manifest.meta.defaultState
  }

  private pickRandomAvailable(candidates: string[]): string {
    const available = candidates.filter((key) => this.manifest.clips[key])
    if (available.length === 0) return this.manifest.meta.defaultState
    return available[Math.floor(Math.random() * available.length)]
  }
}
