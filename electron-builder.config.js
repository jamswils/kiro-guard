/**
 * Electron Builder config — Kiro Guard
 * Windows-first. Produces NSIS installer + portable EXE.
 */
module.exports = {
  appId: 'com.kiro.guard',
  productName: 'Kiro Guard',
  copyright: 'Copyright © 2025',

  directories: {
    output: 'release',
    buildResources: 'assets',
  },

  files: [
    'dist/**/*',
    'assets/pet/**/*',
    'assets/animations/**/*',
    'assets/tray-icon.png',
    'package.json',
  ],

  extraResources: [
    {
      from: 'assets/animations',
      to: 'animations',
      filter: ['**/*.json'],
    },
  ],

  win: {
    target: [
      { target: 'nsis',     arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    // No custom .ico shipped yet — electron-builder falls back to the default
    // Electron icon. Add assets/icon.ico and restore `icon: 'assets/icon.ico'`
    // to brand the installer/exe.

    // Skip exe signing/metadata editing. Preparing the winCodeSign tooling
    // requires creating symlinks, which needs Windows Developer Mode or
    // admin rights — not available on managed machines. Without this flag,
    // `npm run pack`/`dist` fails with "Cannot create symbolic link" while
    // extracting the winCodeSign cache. Trade-off: the exe keeps default
    // Electron version metadata.
    signAndEditExecutable: false,
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: 'Kiro Guard',
    runAfterFinish: true,
  },

  mac: {
    target: ['dmg'],
    category: 'public.app-category.developer-tools',
  },

  linux: {
    target: ['AppImage'],
    category: 'Development',
  },

  asar: true,
  asarUnpack: [
    'assets/pet/**/*',
  ],

  extraMetadata: {
    main: 'dist/main/main/index.js',
  },
}
