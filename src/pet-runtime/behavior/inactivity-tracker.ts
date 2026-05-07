export class InactivityTracker {
  private lastInteractionAt = performance.now()

  markInteraction(): void {
    this.lastInteractionAt = performance.now()
  }

  get idleForMs(): number {
    return performance.now() - this.lastInteractionAt
  }
}
