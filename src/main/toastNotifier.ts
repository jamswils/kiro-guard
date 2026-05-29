import { BrowserWindow, Notification } from 'electron'
import type { NotificationConfig, PetState } from '../shared/types'
import { STATE_TITLES } from '../shared/constants'

let notificationConfig: NotificationConfig = {
  enabled: true,
  onDone: true,
  onError: true,
}

let overlay: BrowserWindow | null = null

export function configureToastNotifier(
  config: NotificationConfig,
  overlayWindow: BrowserWindow | null,
): void {
  notificationConfig = config
  overlay = overlayWindow
}

export function notifyForStatus(status: PetState, message: string): void {
  if (!notificationConfig.enabled) {
    return
  }

  if (status === 'done' && !notificationConfig.onDone) {
    return
  }

  if (status === 'error' && !notificationConfig.onError) {
    return
  }

  if (status !== 'done' && status !== 'error') {
    return
  }

  if (overlay?.isFocused()) {
    return
  }

  new Notification({
    title: STATE_TITLES[status],
    body: message,
  }).show()
}
