/**
 * @jest-environment jsdom
 */

import { DomTooltipBubble } from '../../src/renderer/tooltipBubble'
import { TOOLTIP_MAX_CHARS } from '../../src/shared/constants'

describe('DomTooltipBubble', () => {
  let element: HTMLElement
  let tooltip: DomTooltipBubble

  beforeEach(() => {
    jest.useFakeTimers()
    element = document.createElement('div')
    element.hidden = true
    tooltip = new DomTooltipBubble(element)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('shows messages without truncation when they fit', () => {
    tooltip.show('Kiro is working')

    expect(element.hidden).toBe(false)
    expect(element.textContent).toBe('Kiro is working')
  })

  it('truncates messages longer than the tooltip limit', () => {
    const message = 'x'.repeat(TOOLTIP_MAX_CHARS + 10)

    tooltip.show(message)

    expect(element.textContent).toBe(`${'x'.repeat(TOOLTIP_MAX_CHARS)}...`)
  })

  it('hides and clears the tooltip', () => {
    tooltip.show('Done')
    tooltip.hide()

    expect(element.hidden).toBe(true)
    expect(element.textContent).toBe('')
  })

  it('auto-hides after the requested duration', () => {
    tooltip.show('Done')
    tooltip.setAutoHide(4000)

    jest.advanceTimersByTime(3999)
    expect(element.hidden).toBe(false)

    jest.advanceTimersByTime(1)
    expect(element.hidden).toBe(true)
  })

  it('replaces the previous auto-hide timer', () => {
    tooltip.show('Done')
    tooltip.setAutoHide(1000)
    tooltip.setAutoHide(4000)

    jest.advanceTimersByTime(1000)
    expect(element.hidden).toBe(false)

    jest.advanceTimersByTime(3000)
    expect(element.hidden).toBe(true)
  })
})
