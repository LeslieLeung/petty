import type { RuntimeBehaviorAction, RuntimeManifest } from '../resource/runtime-manifest'
import type { PetStateMachine } from '../state/pet-state-machine'
import type { InactivityTracker } from './inactivity-tracker'

export interface SchedulerDecision {
  clipKey?: string
  reason: string
}

export class BehaviorScheduler {
  private cooldowns = new Map<string, number>()

  constructor(
    private readonly manifest: RuntimeManifest,
    private readonly stateMachine: PetStateMachine,
    private readonly inactivity: InactivityTracker,
  ) {}

  tick(): SchedulerDecision {
    if (!this.manifest.capabilities.autonomousBehavior) return { reason: 'autonomous-disabled' }
    if (this.inactivity.idleForMs < this.manifest.behaviorPolicy.inactivityThresholds.autonomousMs) {
      return { reason: 'waiting-for-inactivity' }
    }

    const action = this.pickAction()
    if (!action) return { reason: 'no-autonomous-candidate' }

    this.cooldowns.set(action.key, performance.now() + action.cooldownSeconds * 1000)
    const clipKey = this.stateMachine.requestAutonomous(action.candidateClips, `autonomous:${action.key}`)
    return { clipKey, reason: `autonomous:${action.key}` }
  }

  private pickAction(): RuntimeBehaviorAction | undefined {
    const now = performance.now()
    const candidates = this.manifest.behaviorPolicy.actions.filter((action) => {
      const cooldownUntil = this.cooldowns.get(action.key) ?? 0
      return cooldownUntil <= now && action.candidateClips.some((clipKey) => this.manifest.clips[clipKey])
    })
    const totalWeight = candidates.reduce((sum, action) => sum + action.weight, 0)
    if (totalWeight <= 0) return undefined

    let cursor = Math.random() * totalWeight
    for (const action of candidates) {
      cursor -= action.weight
      if (cursor <= 0) return action
    }
    return candidates.at(-1)
  }
}
