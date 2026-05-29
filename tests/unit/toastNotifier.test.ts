const showMock = jest.fn()
const notificationMock = jest.fn(() => ({ show: showMock }))

jest.mock('electron', () => ({
  Notification: notificationMock,
}))

import { configureToastNotifier, notifyForStatus } from '../../src/main/toastNotifier'

function overlay(isFocused: boolean) {
  return {
    isFocused: jest.fn(() => isFocused),
  } as never
}

describe('toastNotifier', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    configureToastNotifier(
      { enabled: true, onDone: true, onError: true },
      overlay(false),
    )
  })

  it('fires a notification for done when enabled', () => {
    notifyForStatus('done', 'Finished task')

    expect(notificationMock).toHaveBeenCalledWith({
      title: 'Kiro is done',
      body: 'Finished task',
    })
    expect(showMock).toHaveBeenCalled()
  })

  it('fires a notification for error when enabled', () => {
    notifyForStatus('error', 'Build failed')

    expect(notificationMock).toHaveBeenCalledWith({
      title: 'Kiro encountered an error',
      body: 'Build failed',
    })
    expect(showMock).toHaveBeenCalled()
  })

  it('does not notify for non-terminal states', () => {
    notifyForStatus('working', 'Thinking')

    expect(notificationMock).not.toHaveBeenCalled()
  })

  it('suppresses notifications when disabled', () => {
    configureToastNotifier(
      { enabled: false, onDone: true, onError: true },
      overlay(false),
    )

    notifyForStatus('done', 'Finished task')

    expect(notificationMock).not.toHaveBeenCalled()
  })

  it('respects done and error channel preferences', () => {
    configureToastNotifier(
      { enabled: true, onDone: false, onError: false },
      overlay(false),
    )

    notifyForStatus('done', 'Finished')
    notifyForStatus('error', 'Failed')

    expect(notificationMock).not.toHaveBeenCalled()
  })

  it('suppresses notifications while the overlay is focused', () => {
    configureToastNotifier(
      { enabled: true, onDone: true, onError: true },
      overlay(true),
    )

    notifyForStatus('done', 'Finished task')

    expect(notificationMock).not.toHaveBeenCalled()
  })
})
