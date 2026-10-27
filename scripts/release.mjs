#!/usr/bin/env node
/* Four-package release gate. Importing this module never runs a command or fetch. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
export const RELEASE_PACKAGES = Object.freeze([
  { id: 'pi', name: '@robiteame/dsh-pi-agent-session-tree', dir: 'packages/extensions/pi-agent-session-tree' },
  { id: 'tool', name: '@robiteame/dsh-tool-session-tree', dir: 'packages/extensions/tool-session-tree' },
  { id: 'ui', name: '@robiteame/dsh-client-ui-session-tree', dir: 'packages/client/ui-session-tree' },
  { id: 'carrier', name: '@robiteame/dsh-session-tree', dir: 'packages/bundle/session-tree' },
].map(Object.freeze))
const INTERNAL_NAMES = new Set(RELEASE_PACKAGES.map(pkg => pkg.name))
const HELP = `Usage: node scripts/release.mjs [--dry-run | --check | --publish] [--registry URL] [--version VERSION]

  --dry-run   Default: validate local manifests and print the publication order.
              No subprocesses, network requests, packing, or publication.
  --check     Read-only: require all four exact versions on the registry and
              validate their names, versions, and internal dependency ranges.
  --publish   Publish pi, tool, ui in order, skipping verified existing versions.
              Re-fetch all three implementation versions before carrier publish;
              then check all four published manifests. Any registry error fails.
  --registry  Registry used for BOTH checks and npm publish (default: ${DEFAULT_REGISTRY}).
  --version   Exact version to check, e.g. --check --version 0.3.0. For publication
              or dry-run it must equal all four local manifest versions.
  --help      Show this help.

Build and verify package artifacts before using --publish. Registry checks are
anonymous; this script does not read or change npm credentials. Only npm publish
uses your existing npm configuration. Registry propagation failures stop the
release; rerun --check or --publish after the exact versions become visible.
`

export function parseArgs(args) {
  const options = { mode: 'dry-run', registry: DEFAULT_REGISTRY }
  let explicitMode
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--dry-run', '--check', '--publish'].includes(arg)) {
      if (explicitMode && explicitMode !== arg) throw new Error('Choose only one of --dry-run, --check, and --publish')
      explicitMode = arg
      options.mode = arg.slice(2)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--registry' || arg === '--version' || arg.startsWith('--registry=') || arg.startsWith('--version=')) {
      const [flag, ...inline] = arg.split('=')
      if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`)
      seen.add(flag)
      const value = inline.length > 0 ? inline.join('=') : args[++i]
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
      options[flag.slice(2)] = value
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function validateVersion(version) {
  if (typeof version !== 'string' || semver.valid(version) !== version) {
    throw new Error(`Expected an exact semver version, got ${String(version)}`)
  }
}

function normalizeRegistry(value) {
  let registry
  try {
    registry = new URL(value)
  } catch {
    throw new Error('Invalid registry URL')
  }
  if (!['https:', 'http:'].includes(registry.protocol) || registry.username || registry.password || registry.search || registry.hash) {
    throw new Error('Registry must be an HTTP(S) URL without credentials, query, or fragment')
  }
  if (!registry.pathname.endsWith('/')) registry.pathname += '/'
  return registry.href
}

export function loadReleasePackages(root = ROOT) {
  return RELEASE_PACKAGES.map(pkg => ({
    ...pkg,
    directory: resolve(root, pkg.dir),
    manifest: JSON.parse(readFileSync(resolve(root, pkg.dir, 'package.json'), 'utf8')),
  }))
}

function validateManifest(pkg, manifest, version, source) {
  const label = `${source}: ${pkg.name}@${version}`
  if (manifest?.name !== pkg.name || manifest?.version !== version) {
    throw new Error(`${label}: expected the same name/version; got ${String(manifest?.name)}@${String(manifest?.version)}`)
  }
  if (manifest.private === true) throw new Error(`${label}: package is private`)
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (!INTERNAL_NAMES.has(name)) continue
      if (typeof range !== 'string' || semver.validRange(range) === null) {
        throw new Error(`${label}: ${section}.${name} has invalid npm semver range ${JSON.stringify(range)}`)
      }
      if (!semver.satisfies(version, range)) {
        throw new Error(`${label}: ${section}.${name} range ${JSON.stringify(range)} does not match ${version}`)
      }
    }
  }
  if (pkg.id === 'carrier') {
    for (const implementation of RELEASE_PACKAGES.slice(0, 3)) {
      if (typeof manifest.dependencies?.[implementation.name] !== 'string') {
        throw new Error(`${label}: missing dependency ${implementation.name}`)
      }
      if (manifest.optionalDependencies?.[implementation.name] !== undefined) {
        throw new Error(`${label}: ${implementation.name} must be a required dependency`)
      }
    }
  }
  if (pkg.id === 'tool' && typeof manifest.peerDependencies?.[RELEASE_PACKAGES[0].name] !== 'string') {
    throw new Error(`${label}: missing pi peerDependency ${RELEASE_PACKAGES[0].name}`)
  }
}

async function registryManifest(pkg, version, registry, fetch) {
  const url = new URL(`${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}`, registry).href
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new Error(`${pkg.name}@${version}: registry request failed: ${error.message}`)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${pkg.name}@${version}: registry HTTP ${response.status}`)
  let manifest
  try {
    manifest = await response.json()
  } catch {
    throw new Error(`${pkg.name}@${version}: registry returned invalid JSON`)
  }
  validateManifest(pkg, manifest, version, 'registry')
  return manifest
}

async function readRegistryPackages(packages, version, registry, fetch, { requireAll, log }) {
  const found = new Map()
  const errors = []
  // Deliberately sequential: the order and every request are easy to audit.
  for (const pkg of packages) {
    try {
      const manifest = await registryManifest(pkg, version, registry, fetch)
      if (manifest) found.set(pkg.id, manifest)
      else if (requireAll) errors.push(`${pkg.name}@${version}: missing (HTTP 404)`)
      log(`${manifest ? 'found' : 'missing'} ${pkg.name}@${version}`)
    } catch (error) {
      errors.push(error.message)
    }
  }
  if (errors.length > 0) throw new Error(`Registry check failed at ${registry}:\n${errors.map(error => `  - ${error}`).join('\n')}`)
  return found
}

/** The injected run contract is (command, args, { cwd }) -> { status: number }. */
function runCommand(command, args, options) {
  if (process.platform === 'win32' && command === 'npm') {
    // Execute npm's JS CLI directly: npm.cmd requires a shell on Windows.
    const candidates = [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
    if (process.env.npm_execpath?.endsWith('npm-cli.js')) candidates.unshift(process.env.npm_execpath)
    const cli = candidates.find(path => existsSync(path))
    if (!cli) throw new Error('Cannot locate npm-cli.js beside node; run with a Node installation that includes npm')
    return spawnSync(process.execPath, [cli, ...args], { ...options, stdio: 'inherit', shell: false })
  }
  return spawnSync(command, args, { ...options, stdio: 'inherit', shell: false })
}

/**
 * All side effects are behind fetch/run. Tests inject both, plus in-memory
 * package manifests, so neither a registry nor npm credentials are needed.
 */
export async function runRelease(options = {}, dependencies = {}) {
  const mode = options.mode ?? 'dry-run'
  if (!['dry-run', 'check', 'publish'].includes(mode)) throw new Error(`Unknown release mode: ${mode}`)
  const registry = normalizeRegistry(options.registry ?? DEFAULT_REGISTRY)
  const packages = dependencies.packages ?? loadReleasePackages(dependencies.root)
  if (packages.length !== RELEASE_PACKAGES.length || packages.some((pkg, i) => pkg.id !== RELEASE_PACKAGES[i].id || pkg.name !== RELEASE_PACKAGES[i].name)) {
    throw new Error('Release packages must be pi, tool, ui, carrier in that order with their expected package names')
  }
  const version = options.version ?? packages[3].manifest.version
  validateVersion(version)
  const log = dependencies.log ?? console.log
  const fetch = dependencies.fetch ?? globalThis.fetch
  const run = dependencies.run ?? runCommand
  log(`${mode}: release ${version}; registry ${registry}`)

  if (mode !== 'check') {
    for (const pkg of packages) validateManifest(pkg, pkg.manifest, version, 'local')
  }
  if (mode === 'dry-run') {
    log('Dry-run: no commands or network requests will execute. Build and verify artifacts before --publish.')
    for (const pkg of packages) log(`would publish (or skip verified existing) ${pkg.name}@${version}`)
    log('carrier gate: re-fetch pi, tool, ui at this exact version and validate internal ranges')
    return { mode, version, registry, planned: packages.map(pkg => pkg.name) }
  }

  if (mode === 'check') {
    await readRegistryPackages(packages, version, registry, fetch, { requireAll: true, log })
    log(`complete: all four packages at ${version} are available with matching internal ranges`)
    return { mode, version, registry }
  }

  // Check all existing versions before publishing anything. Only an actual 404
  // means absent; auth errors, server errors, identity mismatch, and bad JSON fail.
  const existing = await readRegistryPackages(packages, version, registry, fetch, { requireAll: false, log })
  const published = []
  const skipped = []
  async function publish(pkg) {
    if (existing.has(pkg.id)) {
      skipped.push(pkg.name)
      log(`skip existing ${pkg.name}@${version} (same name/version and valid ranges)`)
      return
    }
    log(`publish ${pkg.name}@${version}`)
    // npm's scope-specific registry otherwise takes precedence over --registry.
    const scope = pkg.name.split('/')[0]
    const result = await run('npm', [
      'publish', '--access', 'public', '--ignore-scripts',
      '--registry', registry, `--${scope}:registry=${registry}`,
    ], { cwd: pkg.directory })
    if (result?.error || result?.status !== 0) {
      throw new Error(`npm publish failed for ${pkg.name}@${version}: ${result?.error?.message ?? `exit status ${String(result?.status)}`}`)
    }
    published.push(pkg.name)
  }

  for (const pkg of packages.slice(0, 3)) await publish(pkg)
  // This gate must stay immediately before carrier publication, even when npm
  // claimed success or the carrier itself was already published previously.
  await readRegistryPackages(packages.slice(0, 3), version, registry, fetch, { requireAll: true, log })
  await publish(packages[3])
  await readRegistryPackages(packages, version, registry, fetch, { requireAll: true, log })
  log(`complete: all four packages at ${version} are available with matching internal ranges`)
  return { mode, version, registry, published, skipped }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args)
  if (options.help) {
    ;(dependencies.log ?? console.log)(HELP)
    return { help: true }
  }
  return runRelease(options, dependencies)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`release failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
