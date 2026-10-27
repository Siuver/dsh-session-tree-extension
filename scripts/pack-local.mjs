#!/usr/bin/env node
// Stage a local carrier with its implementation packages and runtime dependencies.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = resolve(root, 'dist')
const destination = resolve(output, 'session-tree-local')
const implementations = [
  'packages/extensions/pi-agent-session-tree',
  'packages/extensions/tool-session-tree',
  'packages/client/ui-session-tree',
]
const readManifest = directory => JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))

function npmPack(directory, dryRun = false) {
  const args = ['pack', '--ignore-scripts', '--json', ...(dryRun ? ['--dry-run'] : [])]
  const windowsCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  const command = process.platform === 'win32' ? process.execPath : 'npm'
  const commandArgs = process.platform === 'win32' ? [windowsCli, ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd: directory,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`npm pack failed in ${directory}: ${result.error?.message ?? result.stderr}`)
  }
  return JSON.parse(result.stdout)[0]
}

function copyPackage(source, target) {
  const manifest = readManifest(source)
  if (!manifest.name.startsWith('@robiteame/')) {
    cpSync(source, target, {
      recursive: true,
      dereference: true,
      filter: path => path === source || !relative(source, path).split(/[\\/]/).includes('node_modules'),
    })
    delete manifest.scripts
    delete manifest.devDependencies
    writeFileSync(resolve(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  }
  const packed = npmPack(source, true)
  mkdirSync(target, { recursive: true })
  for (const { path } of packed.files) {
    const from = resolve(source, path)
    const to = resolve(target, path)
    if (isAbsolute(path) || relative(source, from).startsWith('..') || relative(target, to).startsWith('..')) {
      throw new Error(`unsafe package path: ${path}`)
    }
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { dereference: true })
  }
  // Build commands reference the development workspace and are not install hooks.
  delete manifest.scripts
  delete manifest.devDependencies
  writeFileSync(resolve(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

mkdirSync(output, { recursive: true })
const stage = mkdtempSync(resolve(output, '.session-tree-local-'))
let keepStage = false
try {
  const carrier = copyPackage(resolve(root, 'packages/bundle/session-tree'), stage)
  const bundled = new Map()
  const queue = implementations.map(path => ({ source: resolve(root, path), name: readManifest(resolve(root, path)).name }))
  while (queue.length > 0) {
    const { source, name } = queue.shift()
    if (bundled.has(name)) continue
    const target = resolve(stage, 'node_modules', name)
    const manifest = copyPackage(source, target)
    if (manifest.name !== name) throw new Error(`expected ${name}, received ${manifest.name}`)
    bundled.set(name, manifest)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@deepseek-ai/')) throw new Error(`Harness package must remain a peer: ${dependency}`)
      if (implementations.some(path => readManifest(resolve(root, path)).name === dependency)) continue
      const candidate = resolve(root, 'node_modules', dependency)
      if (!existsSync(resolve(candidate, 'package.json'))) throw new Error(`runtime dependency is not installed: ${dependency}`)
      queue.push({ source: candidate, name: dependency })
    }
  }
  for (const manifest of [carrier, ...bundled.values()]) {
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        const local = bundled.get(name)
        if (local && !semver.satisfies(local.version, range)) {
          throw new Error(`${manifest.name}: ${name}@${local.version} does not satisfy ${range}`)
        }
        if (name.startsWith('@robiteame/') && !local) throw new Error(`local package is missing: ${name}`)
      }
    }
  }
  carrier.private = true
  carrier.bundledDependencies = [...bundled.keys()]
  // npm/pnpm include each bundled runtime dependency explicitly in this carrier.
  carrier.dependencies = Object.fromEntries([...bundled].map(([name, manifest]) => [name, manifest.version]))
  carrier.peerDependencies = Object.assign({}, ...[...bundled.values()].map(manifest =>
    Object.fromEntries(Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => !bundled.has(name)))))
  // DSH evaluates engines.dsh alone, so it must match the implementations' Harness peers.
  const dshRanges = new Set([...bundled.values()].flatMap(manifest => Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/.test(name))
    .map(([, range]) => range)))
  if (dshRanges.size !== 1) throw new Error(`implementation packages disagree on the DSH peer range: ${[...dshRanges].join(', ')}`)
  carrier.engines = { ...carrier.engines, dsh: [...dshRanges][0] }
  delete carrier.publishConfig
  writeFileSync(resolve(stage, 'package.json'), `${JSON.stringify(carrier, null, 2)}\n`)
  const packed = npmPack(stage)
  const packedPaths = new Set(packed.files.map(file => file.path))
  for (const name of bundled.keys()) {
    if (!packedPaths.has(`node_modules/${name}/package.json`)) throw new Error(`archive does not contain bundled package ${name}`)
  }
  if (packed.files.some(file => /(?:^|\/)src\//.test(file.path) && file.path.includes('@robiteame/'))) {
    throw new Error('local archive contains implementation source directories')
  }
  const tarball = resolve(output, packed.filename.replace(/\.tgz$/, '-local.tgz'))
  if (existsSync(tarball)) rmSync(tarball)
  renameSync(resolve(stage, packed.filename), tarball)
  // This is a fixed build-output directory; do not accept a user-supplied deletion path.
  if (destination !== resolve(root, 'dist/session-tree-local')) throw new Error('invalid local output path')
  if (existsSync(destination)) rmSync(destination, { recursive: true })
  renameSync(stage, destination)
  keepStage = true
  process.stdout.write(`local directory: ${destination}\nlocal tarball: ${tarball}\nbundled: ${[...bundled.keys()].join(', ')}\n`)
} finally {
  if (!keepStage) rmSync(stage, { recursive: true, force: true })
}
