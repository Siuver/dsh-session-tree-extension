#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { BUNDLED_PACKAGES, DEFAULT_REGISTRY, RELEASE_PACKAGE, loadReleasePackage, main, parseArgs, runRelease } from '../release.mjs'

function manifest(version = '1.0.0') {
  return {
    name: RELEASE_PACKAGE.name,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    dependencies: { ...Object.fromEntries(BUNDLED_PACKAGES.map(name => [name, version])), zod: '4.4.3' },
    bundledDependencies: [...BUNDLED_PACKAGES, 'zod'],
  }
}

function staged(version = '1.0.0') {
  return {
    ...RELEASE_PACKAGE,
    directory: resolve('fixture', RELEASE_PACKAGE.dir),
    manifest: manifest(version),
    installed: Object.fromEntries(BUNDLED_PACKAGES.map(name => [name, version])),
  }
}

function response(body, status = body ? 200 : 404) {
  return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) }
}

/** Every test uses in-memory registry state and an injected runner. */
function simulator({ pkg = staged(), existing, invisible = false, onFetch, onRun } = {}) {
  const state = { published: existing === undefined ? undefined : structuredClone(existing) }
  const calls = []
  const requests = []
  const events = []
  const logs = []
  const dependencies = {
    pkg,
    log: message => logs.push(message),
    fetch: async (url, options) => {
      const parts = new URL(url).pathname.split('/').filter(Boolean)
      const request = { url, options, name: decodeURIComponent(parts.at(-2)), version: decodeURIComponent(parts.at(-1)), count: requests.length + 1 }
      assert.equal(request.name, RELEASE_PACKAGE.name)
      requests.push(request)
      events.push('get')
      const override = await onFetch?.(request)
      return override ?? response(state.published?.version === request.version ? state.published : undefined)
    },
    run: async (command, args, options) => {
      const call = { command, args, options }
      calls.push(call)
      events.push('publish')
      const result = await onRun?.(call) ?? { status: 0 }
      if (result.status === 0 && !result.error && !invisible) state.published = structuredClone(pkg.manifest)
      return result
    },
  }
  return { dependencies, pkg, state, calls, requests, events, logs }
}

test('default and explicit dry-run validate the staged package without any subprocess or fetch', async () => {
  for (const args of [[], ['--dry-run']]) {
    const sim = simulator()
    const result = await main(args, sim.dependencies)
    assert.equal(result.mode, 'dry-run')
    assert.equal(result.planned, RELEASE_PACKAGE.name)
    assert.deepEqual(sim.events, [])
  }
})

test('help never invokes network, commands, or manifest loading', async () => {
  const sim = simulator()
  assert.deepEqual(await main(['--help'], { ...sim.dependencies, root: '/does-not-exist', pkg: undefined }), { help: true })
  assert.deepEqual(sim.events, [])
  assert.match(sim.logs[0], /--publish/)
})

test('argument parsing fails closed on conflicting modes, unknown flags, and missing values', () => {
  assert.deepEqual(parseArgs([]), { mode: 'dry-run', registry: DEFAULT_REGISTRY })
  assert.deepEqual(parseArgs(['--check', '--version=1.0.0', '--registry', 'https://registry.example/npm']), {
    mode: 'check', version: '1.0.0', registry: 'https://registry.example/npm',
  })
  for (const args of [
    ['--check', '--publish'], ['--dry-run', '--publish'], ['--publish=false'],
    ['--registry'], ['--version', '--publish'], ['--version='],
    ['--registry', 'https://one.example', '--registry=https://two.example'],
  ]) assert.throws(() => parseArgs(args))
})

test('publish checks the registry, publishes the staged directory once, and re-checks', async () => {
  const sim = simulator()
  const result = await main(['--publish'], sim.dependencies)
  assert.deepEqual(sim.events, ['get', 'publish', 'get'])
  assert.deepEqual(result.published, [RELEASE_PACKAGE.name])
  assert.deepEqual(result.skipped, [])
  assert.equal(sim.calls[0].command, 'npm')
  assert.equal(sim.calls[0].options.cwd, sim.pkg.directory)
  assert.deepEqual(sim.calls[0].args, [
    'publish', '--access', 'public', '--ignore-scripts',
    '--registry', DEFAULT_REGISTRY, `--@siuver:registry=${DEFAULT_REGISTRY}`,
  ])
})

test('an existing valid version is skipped without publishing', async () => {
  const sim = simulator({ existing: manifest() })
  const result = await main(['--publish'], sim.dependencies)
  assert.deepEqual(result.published, [])
  assert.deepEqual(result.skipped, [RELEASE_PACKAGE.name])
  assert.deepEqual(sim.events, ['get'])
})

for (const field of ['name', 'version', 'bundle']) {
  test(`an existing package with a wrong ${field} cannot be skipped as a successful publication`, async () => {
    const wrong = manifest()
    if (field === 'name') wrong.name = '@other/dsh-session-tree'
    if (field === 'version') wrong.version = '0.9.0'
    if (field === 'bundle') delete wrong.bundledDependencies
    const sim = simulator({ onFetch: () => response(wrong) })
    await assert.rejects(main(['--publish'], sim.dependencies), field === 'bundle' ? /bundled dependency/ : /expected the same name\/version/)
    assert.equal(sim.calls.length, 0)
  })
}

for (const status of [401, 403, 429, 500, 503]) {
  test(`registry HTTP ${status} fails preflight instead of being treated as a missing version`, async () => {
    const sim = simulator({ onFetch: () => response(undefined, status) })
    await assert.rejects(main(['--publish'], sim.dependencies), new RegExp(`registry HTTP ${status}`))
    assert.equal(sim.calls.length, 0)
  })
}

test('a registry network failure or invalid JSON on preflight executes no npm commands', async () => {
  for (const onFetch of [
    () => { throw new Error('ECONNRESET') },
    () => ({ ok: true, status: 200, json: async () => { throw new Error('bad JSON') } }),
  ]) {
    const sim = simulator({ onFetch })
    await assert.rejects(main(['--publish'], sim.dependencies), /registry request failed: ECONNRESET|invalid JSON/)
    assert.equal(sim.calls.length, 0)
  }
})

for (const failure of [{ status: 1 }, { status: null }, { status: 0, error: new Error('spawn failed') }]) {
  test(`npm failure (${failure.error?.message ?? failure.status}) fails the release`, async () => {
    const sim = simulator({ onRun: () => failure })
    await assert.rejects(main(['--publish'], sim.dependencies), /npm publish failed/)
    assert.deepEqual(sim.events, ['get', 'publish'])
  })
}

test('a package missing after a successful npm publish fails the final check', async () => {
  const sim = simulator({ invisible: true })
  await assert.rejects(main(['--publish'], sim.dependencies), /missing \(HTTP 404\) after npm publish/)
})

test('check is read-only and validates the published manifest', async () => {
  const sim = simulator({ existing: manifest('1.0.0') })
  const result = await main(['--check', '--version', '1.0.0'], sim.dependencies)
  assert.equal(result.version, '1.0.0')
  assert.deepEqual(sim.events, ['get'])
  const missing = simulator()
  await assert.rejects(main(['--check', '--version=1.0.0'], missing.dependencies), /missing \(HTTP 404\)/)
  assert.equal(missing.calls.length, 0)
})

test('check accepts the npm registry spelling bundleDependencies and rejects inexact bundled ranges', async () => {
  const normalized = manifest()
  normalized.bundleDependencies = normalized.bundledDependencies
  delete normalized.bundledDependencies
  await main(['--check'], simulator({ existing: normalized }).dependencies)
  const ranged = manifest()
  ranged.dependencies[BUNDLED_PACKAGES[0]] = '^1.0.0'
  await assert.rejects(main(['--check'], simulator({ existing: ranged }).dependencies), /must be exactly 1.0.0/)
})

test('custom registry, including a path prefix, is used for exact lookups and the publish', async () => {
  const sim = simulator()
  const registry = 'https://registry.example/npm'
  const result = await main(['--publish', '--registry', registry], sim.dependencies)
  assert.equal(result.registry, `${registry}/`)
  for (const request of sim.requests) {
    assert.ok(request.url.startsWith(`${registry}/`))
    assert.equal(request.version, '1.0.0')
    assert.equal(request.options.method, 'GET')
    assert.equal(request.options.cache, 'no-store')
    assert.equal(request.options.redirect, 'error')
    assert.equal(request.options.headers.authorization, undefined)
  }
  assert.equal(sim.calls[0].args[sim.calls[0].args.indexOf('--registry') + 1], `${registry}/`)
  assert.equal(sim.calls[0].args.at(-1), `--@siuver:registry=${registry}/`)
})

test('local identity, privacy, and bundle mismatches fail before any network request or subprocess', async () => {
  for (const mutation of [
    pkg => { pkg.manifest.name = '@robiteame/dsh-session-tree' },
    pkg => { pkg.manifest.private = true },
    pkg => { delete pkg.manifest.dsh },
    pkg => { pkg.manifest.bundledDependencies = ['zod'] },
    pkg => { pkg.manifest.dependencies[BUNDLED_PACKAGES[1]] = '^1.0.0' },
    pkg => { pkg.installed[BUNDLED_PACKAGES[2]] = '0.7.0' },
    pkg => { pkg.installed[BUNDLED_PACKAGES[0]] = undefined },
  ]) {
    const sim = simulator()
    mutation(sim.pkg)
    await assert.rejects(main(['--publish'], sim.dependencies))
    assert.deepEqual(sim.events, [])
  }
  const sim = simulator()
  await assert.rejects(main(['--publish', '--version=0.9.0'], sim.dependencies), /expected the same name\/version/)
  assert.deepEqual(sim.events, [])
})

test('registry URLs with embedded credentials, query strings, or unsupported protocols are rejected without side effects', async () => {
  for (const registry of ['https://user:password@example.org/', 'https://example.org/?token=value', 'https://example.org/#fragment', 'file:///registry', 'invalid']) {
    const sim = simulator()
    await assert.rejects(main(['--publish', '--registry', registry], sim.dependencies), /registry|Registry/)
    assert.deepEqual(sim.events, [])
  }
})

test('version selectors and invalid versions cannot substitute a tag or range for an exact version', async () => {
  for (const version of ['latest', '^1.0.0', '1.0', 'v1.0.0']) {
    const sim = simulator()
    await assert.rejects(main(['--check', '--version', version], sim.dependencies), /exact semver/)
    assert.deepEqual(sim.events, [])
  }
})

test('unknown programmatic modes fail closed instead of entering the publish branch', async () => {
  const sim = simulator()
  await assert.rejects(runRelease({ mode: 'typo' }, sim.dependencies), /Unknown release mode/)
  assert.deepEqual(sim.events, [])
})

test('loadReleasePackage reads the staged carrier and its bundled implementation versions', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-tree-release-'))
  try {
    assert.throws(() => loadReleasePackage(root), /pnpm pack:release/)
    const directory = join(root, RELEASE_PACKAGE.dir)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest()))
    mkdirSync(join(directory, 'node_modules', BUNDLED_PACKAGES[0]), { recursive: true })
    writeFileSync(join(directory, 'node_modules', BUNDLED_PACKAGES[0], 'package.json'), JSON.stringify({ version: '1.0.0' }))
    const pkg = loadReleasePackage(root)
    assert.equal(pkg.manifest.name, RELEASE_PACKAGE.name)
    assert.equal(pkg.installed[BUNDLED_PACKAGES[0]], '1.0.0')
    assert.equal(pkg.installed[BUNDLED_PACKAGES[1]], undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
