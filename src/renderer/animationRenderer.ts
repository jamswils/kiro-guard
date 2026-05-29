import type { AnimationConfig, AnimationKey, AnimationRenderer } from '../shared/types'

const REPEAT_COUNTS: Record<AnimationKey, number> = {
  idle: Infinity,
  working: Infinity,
  waiting: Infinity,
  asking: Infinity,
  'design-working': Infinity,
  'requirements-working': Infinity,
  'tasks-working': Infinity,
  done: 3,
  'design-done': 3,
  'requirements-done': 3,
  'tasks-done': 3,
  error: 2,
}

const FRAME_COUNT = 12
const BASE_FRAME_MS = 83

function framePath(key: AnimationKey, frameIndex: number): string {
  return `../assets/pet/${key}/${key}_${String(frameIndex).padStart(3, '0')}.png`
}

export class SpriteAnimationRenderer implements AnimationRenderer {
  private currentKey: AnimationKey | null = null
  private frameTimer: number | null = null
  private playToken = 0

  constructor(private readonly container: HTMLElement) {}

  play(config: AnimationConfig): void {
    this.stop()
    this.currentKey = config.key
    this.playToken += 1
    const token = this.playToken

    const image = document.createElement('img')
    image.className = 'pet-sprite-frame'
    image.alt = ''
    image.draggable = false
    this.container.replaceChildren(image)

    let frameIndex = 0
    let completedLoops = 0
    const repeatCount = config.loop ? Infinity : REPEAT_COUNTS[config.key]
    const frameMs = Math.max(40, BASE_FRAME_MS / Math.max(config.speed, 0.1))

    const updateFrame = (): void => {
      image.src = framePath(config.key, frameIndex)
      frameIndex = (frameIndex + 1) % FRAME_COUNT

      if (frameIndex === 0) {
        completedLoops += 1
        if (completedLoops >= repeatCount) {
          this.clearTimer()
          if (this.playToken === token) {
            config.onComplete?.()
          }
        }
      }
    }

    updateFrame()
    this.frameTimer = window.setInterval(updateFrame, frameMs)
  }

  stop(): void {
    this.playToken += 1
    this.clearTimer()
    this.container.replaceChildren()
    this.currentKey = null
  }

  getCurrentAnimation(): AnimationKey | null {
    return this.currentKey
  }

  private clearTimer(): void {
    if (this.frameTimer !== null) {
      window.clearInterval(this.frameTimer)
      this.frameTimer = null
    }
  }
}

export function createAnimationRenderer(container: HTMLElement): AnimationRenderer {
  return new SpriteAnimationRenderer(container)
}
