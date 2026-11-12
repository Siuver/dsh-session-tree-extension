#!/usr/bin/env node
/* Release gate for the self-contained carrier package. Importing this module never runs a command or fetch. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
export const RELEASE_PACKAGE = Object.freeze({ name: '@siuver/dsh-session-tree', dir: 'dist/session-tree' })
export const BUNDLED_PACKAGES = Object.freeze([
  '@siuver/dsh-pi-agent-session-tree',
  '@siuver/dsh-tool-session-tree',
  '@siuver/dsh-client-ui-session-tree',
])
const HELP = `Usage: node scripts/release.mjs [--dry-run | --check | --publish] [--registry URL] [--version VERSION]

  --dry-run   Default: validate the staged package in ${RELEASE_PACKAGE.dir} and print the plan.
              No subprocesses, network requests, packing, or publication.
  --check     Read-only: require the exact version on the registry and validate
              its name, version, and bundled implementation packages.
  --publish   Publish the staged package unless that exact version is already
              published and valid, then check the published manifest.
              Any registry error fails.
  --registry  Registry used for BOTH checks and npm publish (default: ${DEFAULT_REGISTRY}).
  --version   Exact version to check, e.g. --check --version 1.0.0. For publication
              or dry-run it must equal the staged package version.
  --help      Show this help.

Stage the package with \`pnpm pack:release\` before using --publish. Registry checks
are anonymous; this script does not read or change npm credentials. Only npm publish
uses your existing npm configuration. Registry propagation failures stop the
release; rerun --check after the exact version becomes visible.
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

/** The staged carrier and the versions of the implementation packages inside its node_modules. */
export function loadReleasePackage(root = ROOT) {
  const directory = resolve(root, RELEASE_PACKAGE.dir)
  const manifestPath = resolve(directory, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`${RELEASE_PACKAGE.dir} is missing; run pnpm pack:release first`)
  const installed = Object.fromEntries(BUNDLED_PACKAGES.map((name) => {
    const path = resolve(directory, 'node_modules', name, 'package.json')
    return [name, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : undefined]
  }))
  return { ...RELEASE_PACKAGE, directory, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), installed }
}

function validateManifest(manifest, version, source, installed) {
  const label = `${source}: ${RELEASE_PACKAGE.name}@${version}`
  if (manifest?.name !== RELEASE_PACKAGE.name || manifest?.version !== version) {
    throw new Error(`${label}: expected the same name/version; got ${String(manifest?.name)}@${String(manifest?.version)}`)
  }
  if (manifest.private === true) throw new Error(`${label}: package is private`)
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error(`${label}: dsh.bundle.patch must be ./cordis.patch.yml`)
  const bundled = new Set(manifest.bundleDependencies ?? manifest.bundledDependencies ?? [])
  for (const name of BUNDLED_PACKAGES) {
    if (!bundled.has(name)) throw new Error(`${label}: ${name} must be a bundled dependency`)
    if (manifest.dependencies?.[name] !== version) {
      throw new Error(`${label}: dependencies.${name} must be exactly ${version}; got ${JSON.stringify(manifest.dependencies?.[name])}`)
    }
    if (installed !== undefined && installed[name] !== version) {
      throw new Error(`${label}: bundled ${name} is ${String(installed[name])}, expected ${version}`)
    }
  }
}

async function registryManifest(version, registry, fetch) {
  const url = new URL(`${encodeURIComponent(RELEASE_PACKAGE.name)}/${encodeURIComponent(version)}`, registry).href
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
    throw new Error(`${RELEASE_PACKAGE.name}@${version}: registry request failed: ${error.message}`)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${RELEASE_PACKAGE.name}@${version}: registry HTTP ${response.status}`)
  let manifest
  try {
    manifest = await response.json()
  } catch {
    throw new Error(`${RELEASE_PACKAGE.name}@${version}: registry returned invalid JSON`)
  }
  validateManifest(manifest, version, 'registry')
  return manifest
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
 * All side effects are behind fetch/run. Tests inject both, plus an in-memory
 * staged package, so neither a registry nor npm credentials are needed.
 */
export async function runRelease(options = {}, dependencies = {}) {
  const mode = options.mode ?? 'dry-run'
  if (!['dry-run', 'check', 'publish'].includes(mode)) throw new Error(`Unknown release mode: ${mode}`)
  const registry = normalizeRegistry(options.registry ?? DEFAULT_REGISTRY)
  const log = dependencies.log ?? console.log
  const fetch = dependencies.fetch ?? globalThis.fetch
  const run = dependencies.run ?? runCommand
  const name = RELEASE_PACKAGE.name

  if (mode === 'check') {
    const version = options.version ?? dependencies.pkg?.manifest.version
      ?? JSON.parse(readFileSync(resolve(dependencies.root ?? ROOT, 'package.json'), 'utf8')).version
    validateVersion(version)
    log(`check: release ${version}; registry ${registry}`)
    const published = await registryManifest(version, registry, fetch)
    if (published === null) throw new Error(`Registry check failed at ${registry}: ${name}@${version} is missing (HTTP 404)`)
    log(`complete: ${name}@${version} is available with its bundled implementation packages`)
    return { mode, version, registry }
  }

  const pkg = dependencies.pkg ?? loadReleasePackage(dependencies.root)
  const version = options.version ?? pkg.manifest.version
  validateVersion(version)
  log(`${mode}: release ${version}; registry ${registry}`)
  validateManifest(pkg.manifest, version, 'local', pkg.installed)
  if (mode === 'dry-run') {
    log('Dry-run: no commands or network requests will execute.')
    log(`would publish (or skip a verified existing) ${name}@${version} from ${pkg.dir}`)
    return { mode, version, registry, planned: name }
  }

  // Only an actual 404 means absent; auth errors, server errors, identity mismatch, and bad JSON fail.
  if (await registryManifest(version, registry, fetch) !== null) {
    log(`skip existing ${name}@${version} (same name/version and bundled packages)`)
    return { mode, version, registry, published: [], skipped: [name] }
  }
  log(`publish ${name}@${version}`)
  // npm's scope-specific registry otherwise takes precedence over --registry.
  const scope = name.split('/')[0]
  const result = await run('npm', [
    'publish', '--access', 'public', '--ignore-scripts',
    '--registry', registry, `--${scope}:registry=${registry}`,
  ], { cwd: pkg.directory })
  if (result?.error || result?.status !== 0) {
    throw new Error(`npm publish failed for ${name}@${version}: ${result?.error?.message ?? `exit status ${String(result?.status)}`}`)
  }
  if (await registryManifest(version, registry, fetch) === null) {
    throw new Error(`Registry check failed at ${registry}: ${name}@${version} is missing (HTTP 404) after npm publish`)
  }
  log(`complete: ${name}@${version} is available with its bundled implementation packages`)
  return { mode, version, registry, published: [name], skipped: [] }
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
