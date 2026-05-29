# Kiro Guard

**A tray-only Windows screen lock with a live Kiro agent-status indicator.**

Kiro Guard combines [kiro-buddy](https://github.com/Jagatees/kiro-buddy)'s agent
status system with [Lockpaw](https://github.com/sorkila/lockpaw)'s screen-guard
concept, rebuilt from scratch for **Windows** in Electron/TypeScript.

It runs from the system tray (no floating desktop window) and gives you a
hotkey-driven lock screen that shows what your Kiro agent is doing while the
screen is locked.

---

## Important: what the lock is and is not

The lock is a **presence overlay** — a "do not disturb, agents are working"
screen. It is **not a security boundary** and must not be relied on to protect
an unattended machine:

- There is no kernel-level input blocking (it was removed because it could
  deadlock the password prompt — see `src/main/lockController.ts`, the
  "Input blocking — DISABLED" section).
- An emergency hotkey (`Ctrl+Shift+Alt+U`) force-unlocks with no password.

For real device security, use Windows' own lock (`Win+L`). Kiro Guard sits on
top of your normal workflow; it does not replace OS-level security.

---

## What it does

### Live agent-status indicator
Kiro Guard watches the per-workspace status files written by kiro-buddy's Kiro
hooks (`~/.kiro-buddy/workspaces/<hash>/status.json`) and surfaces the status of
whichever workspace was most recently active. The lock screen shows the matching
Kiro sprite and a label:

| Status | Label |
|--------|-------|
| `idle` | Kiro Ready |
| `working` | Kiro Processing |
| `asking` | Kiro Asking |
| `waiting` | Kiro Waiting |
| `done` | Kiro Done |
| `error` | Kiro Error |

### Screen lock (Lockpaw concept, rebuilt for Windows)
- **Global hotkey** (`Ctrl+Shift+L` by default) locks the screen.
- Full-screen overlay on every display, at screen-saver window level.
- Kiro sprite floats on the lock screen with a teal glow and a breathing cycle.
- Elapsed timer shows how long the screen has been locked.
- **Optional password auth** to unlock, via Windows credential validation
  (PowerShell `PromptForCredential` + domain/machine/`LogonUser` checks).
- Sleep prevention while locked (`powerSaveBlocker`).
- **Auto-lock** option: locks automatically when a Kiro agent starts working.
- **Emergency unlock**: `Ctrl+Shift+Alt+U` force-unlocks without a password.

> The floating desktop "ghost" companion and pet lock-badge from earlier
> versions have been removed. Kiro Guard is tray-only.

---

## Requirements

- **Windows** (primary target). macOS/Linux build targets exist in
  `electron-builder.config.js` but are unverified.
- **Node.js 18+** and npm.

There is no native-compilation step. (Earlier versions used `uiohook-napi`,
which required Visual Studio Build Tools; that dependency has been removed.)

---

## Install and run

```bash
git clone https://github.com/jamswils/kiro-guard.git
cd kiro-guard
npm install
npm run build
```

### Launching

On most machines:

```bash
npm start
```

**On locked-down / corporate machines**, the Chromium GPU process and renderer
sandbox can fail to initialize, which prevents the lock screen from loading.
`src/main/index.ts` already disables hardware acceleration by default to work
around the GPU half. For the sandbox half, launch with the bundled helper, which
adds `--no-sandbox`:

```
Launch Kiro Guard.bat
```

This writes startup output to `kiro-guard.log` in the project folder for
debugging. To opt hardware acceleration back in, set `KIRO_GUARD_ENABLE_GPU=1`
before launching.

> Why `--no-sandbox` is needed on some machines: the Chromium child-process
> sandbox can abort during startup under certain managed-Windows security
> configurations. `--no-sandbox` is a working bypass for local use. Do not use
> it as a general recommendation for untrusted content.

### Install Kiro hooks

To make the status indicator react to your Kiro agent, install the hooks into
the Kiro project you want to track:

```bash
npm run hooks:install
```

This writes `.kiro/hooks` files into the current workspace. Kiro then updates
the per-workspace status file on every agent event.

---

## Hotkeys

| Action | Default |
|--------|---------|
| Lock screen | `Ctrl+Shift+L` |
| Unlock (when auth not required) | `Ctrl+Shift+L` again |
| Emergency force-unlock (no password) | `Ctrl+Shift+Alt+U` |

You can also lock/unlock from the system tray menu. Change the hotkey via
`~/.kiro-guard/config.json`.

---

## Configuration

Config lives at `~/.kiro-guard/config.json`. Lock settings:

```json
{
  "lock": {
    "hotkey": "Control+Shift+L",
    "requireAuth": false,
    "autoLockOnAgentStart": false,
    "showElapsedTime": true,
    "lockMessage": "Agents are working. Screen locked."
  }
}
```

- **`requireAuth`** — when `true`, unlocking requires your Windows password.
  When `false`, the hotkey or tray click unlocks immediately.
- **`autoLockOnAgentStart`** — when `true`, the screen locks automatically when
  your Kiro agent transitions to `working`.

The "Require password", "Auto-lock", and "Show elapsed time" toggles are also in
the system tray Settings submenu.

---

## Architecture

```
kiro-guard/
├── src/
│   ├── main/                          Electron main process
│   │   ├── index.ts                   Entry point, tray, app wiring
│   │   ├── lockController.ts          Lock state machine, hotkeys, multi-display
│   │   │                              overlays, sleep prevention, Windows auth
│   │   ├── statusManager.ts           Canonical status dispatch + path validation
│   │   ├── multiWorkspaceStatusWatcher.ts  Watches all kiro-buddy workspace files
│   │   ├── ipcHandlers.ts             IPC: lock/unlock/toggle, get state/config
│   │   ├── configStore.ts             electron-store at ~/.kiro-guard/config.json
│   │   └── preload.ts                 Context bridge (kiroBuddy + kiroLock APIs)
│   ├── renderer/
│   │   └── lock.html                  Full-screen lock overlay (sprite + timer + auth)
│   └── shared/
│       ├── types.ts                   Shared types
│       ├── ipc.ts                     IPC channel names + payload validators
│       ├── constants.ts               Timing constants, state maps
│       └── validation.ts              StatusPayload validator
├── assets/
│   ├── pet/                           Kiro sprite frames (from kiro-buddy)
│   └── tray-icon.png
└── scripts/
    ├── build-renderer.cjs             esbuild + asset copy
    ├── kiro-status-hook.(ps1|cjs)     Write status updates
    └── install-kiro-hooks.cjs         Install .kiro/hooks into a workspace
```

The following modules exist and are unit-tested but are **not currently wired
into the running tray app**: `overlayWindow.ts`, `kiroInputMonitor.ts`,
`kiroLifecycle.ts`, `toastNotifier.ts`. They are remnants of the floating-pet
architecture and are kept for reference.

---

## Development

```bash
npm run build        # tsc (main) + esbuild (renderer)
npm test             # jest — unit + property tests
```

---

## Credits

- **[kiro-buddy](https://github.com/Jagatees/kiro-buddy)** by Jagatees — agent
  status system, sprite animations, Kiro hook integration. Sprite assets under
  `assets/pet/` originate from this project.
- **[Lockpaw](https://github.com/sorkila/lockpaw)** by sorkila (Erik Nielsen) —
  screen-guard design and lock state-machine concept. Rebuilt here for
  Windows/Electron.

See `LICENSE` for licensing and third-party attribution notes. Review each
upstream project's license before redistributing this project or its bundled
assets.

---

## Why not just port Lockpaw?

Lockpaw is Swift/SwiftUI and relies on macOS APIs that have no direct Windows
equivalent:

- `CGEventTap` hotkeys -> Electron `globalShortcut`
- `CGShieldingWindowLevel` overlay -> `setAlwaysOnTop('screen-saver', 1)` + `fullscreen`
- `LAContext` Touch ID -> Windows credential validation via PowerShell
- `IOPMAssertion` sleep prevention -> `powerSaveBlocker`
- `NSScreen.screens` multi-display -> `screen.getAllDisplays()`

A port would be a rewrite anyway. Building on kiro-buddy's Electron base
provided the status system and sprite pipeline.
