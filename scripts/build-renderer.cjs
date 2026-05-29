const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'dist', 'renderer')
const assetOutDir = path.join(root, 'dist', 'assets')

fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(assetOutDir, { recursive: true })

// Bundle pet overlay JS
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'renderer', 'pet.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  sourcemap: true,
  target: 'es2020',
  outfile: path.join(outDir, 'pet.js'),
})

// Copy HTML files
fs.copyFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  path.join(outDir, 'index.html'),
)
fs.copyFileSync(
  path.join(root, 'src', 'renderer', 'lock.html'),
  path.join(outDir, 'lock.html'),
)

// Copy CSS files
fs.copyFileSync(
  path.join(root, 'src', 'renderer', 'animations.css'),
  path.join(outDir, 'animations.css'),
)
fs.copyFileSync(
  path.join(root, 'src', 'renderer', 'lock-badge.css'),
  path.join(outDir, 'lock-badge.css'),
)

// Copy assets
fs.cpSync(path.join(root, 'assets'), assetOutDir, { recursive: true })

console.log('[build-renderer] Done')
