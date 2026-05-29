import type { TooltipBubble } from '../shared/types'
import { TOOLTIP_MAX_CHARS } from '../shared/constants'

function truncateMessage(message: string): string {
  if (message.length <= TOOLTIP_MAX_CHARS) {
    return message
  }

  return `${message.slice(0, TOOLTIP_MAX_CHARS)}...`
}

export class DomTooltipBubble implements TooltipBubble {
  private autoHideTimer: number | null = null

  constructor(private readonly element: HTMLElement) {}

  show(message: string): void {
    this.clearTimer()
    this.element.textContent = truncateMessage(message)
    this.element.hidden = false
  }

  hide(): void {
    this.clearTimer()
    this.element.hidden = true
    this.element.textContent = ''
  }

  update(message: string): void {
    this.element.textContent = truncateMessage(message)
  }

  setAutoHide(durationMs: number): void {
    this.clearTimer()
    this.autoHideTimer = window.setTimeout(() => this.hide(), durationMs)
  }

  private clearTimer(): void {
    if (this.autoHideTimer !== null) {
      window.clearTimeout(this.autoHideTimer)
      this.autoHideTimer = null
    }
  }
}

export function createTooltipBubble(element: HTMLElement): TooltipBubble {
  return new DomTooltipBubble(element)
}
