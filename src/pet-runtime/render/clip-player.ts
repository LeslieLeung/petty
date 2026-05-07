import { Rectangle, Texture } from 'pixi.js'
import type { RuntimeAtlas, RuntimeClip } from '../resource/runtime-manifest'

export interface ClipPlayerEvents {
  onClipEnd: () => void
}

export class ClipPlayer {
  private textures = new Map<string, Texture[]>()
  private clip?: RuntimeClip
  private frameIndex = 0
  private elapsedMs = 0
  private clipEndEmitted = false

  constructor(
    private readonly baseTexture: Texture,
    private readonly atlas: RuntimeAtlas,
    private readonly events: ClipPlayerEvents,
  ) {}

  play(clip: RuntimeClip): Texture {
    if (this.clip?.key !== clip.key) {
      this.clip = clip
      this.frameIndex = 0
      this.elapsedMs = 0
      this.clipEndEmitted = false
    }
    return this.currentTexture()
  }

  update(deltaMs: number): Texture {
    if (!this.clip) return this.currentTexture()
    this.elapsedMs += deltaMs

    while (this.elapsedMs >= this.currentFrameDurationMs()) {
      this.elapsedMs -= this.currentFrameDurationMs()
      this.frameIndex += 1
      if (this.frameIndex >= this.clip.frames.length) {
        if (this.clip.loop) {
          this.frameIndex = 0
        } else {
          this.frameIndex = this.clip.frames.length - 1
          if (!this.clipEndEmitted) {
            this.clipEndEmitted = true
            this.events.onClipEnd()
          }
          break
        }
      }
    }

    return this.currentTexture()
  }

  private currentTexture(): Texture {
    if (!this.clip) return this.baseTexture
    const textures = this.getTextures(this.clip)
    return textures[this.frameIndex] ?? textures[0] ?? this.baseTexture
  }

  private currentFrameDurationMs(): number {
    if (!this.clip) return 1000
    return this.clip.frameDurationsMs?.[this.frameIndex] ?? 1000 / this.clip.fps
  }

  private getTextures(clip: RuntimeClip): Texture[] {
    const cached = this.textures.get(clip.key)
    if (cached) return cached

    const textures = clip.frames.map((frame) => {
      return new Texture({
        source: this.baseTexture.source,
        frame: new Rectangle(
          frame.col * this.atlas.cellWidth,
          frame.row * this.atlas.cellHeight,
          this.atlas.cellWidth,
          this.atlas.cellHeight,
        ),
      })
    })
    this.textures.set(clip.key, textures)
    return textures
  }
}
