#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { DEFAULT_REGISTRY, RELEASE_PACKAGES, main, parseArgs, runRelease } from '../release.mjs'

function fixtures(version = '0.6.0') {
  const packages = RELEASE_PACKAGES.map(pkg => ({
    ...pkg,
    directory: resolve('fixture', pkg.dir),
    manifest: { name: pkg.name, version },
  }))
  packages[1].manifest.peerDependencies = { [packages[0].name]: `^${version}` }
  packages[3].manifest.dependencies = Object.fromEntries(packages.slice(0, 3).map(pkg => [pkg.name, `^${version}`]))
  return packages
}

function response(manifest, status = manifest ? 200 : 404) {
  return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(manifest) }
}

/** Every test uses in-memory registry state and an injected runner. */
function simulator({ packages = fixtures(), existing = [], invisible = [], onFetch, onRun } = {}) {
  const state = new Map(existing.map(pkg => [`${pkg.manifest.name}@${pkg.manifest.version}`, structuredClone(pkg.manifest)]))
  const calls = []
  const requests = []
  const events = []
  const logs = []
  const counts = new Map()
  const dependencies = {
    packages,
    log: message => logs.push(message),
    fetch: async (url, options) => {
      const parts = new URL(url).pathname.split('/').filter(Boolean)
      const name = decodeURIComponent(parts.at(-2))
      const version = decodeURIComponent(parts.at(-1))
      const pkg = packages.find(pkg => pkg.name === name)
      assert.ok(pkg, `unexpected package lookup ${url}`)
      const count = (counts.get(pkg.id) ?? 0) + 1
      counts.set(pkg.id, count)
      const request = { pkg, url, options, version, count, state }
      requests.push(request)
      events.push(`get:${pkg.id}`)
      const override = await onFetch?.(request)
      return override ?? response(state.get(`${name}@${version}`))
    },
    run: async (command, args, options) => {
      const pkg = packages.find(pkg => pkg.directory === options.cwd)
      assert.ok(pkg, `unexpected publication directory ${options.cwd}`)
      const call = { pkg, command, args, options, state }
      calls.push(call)
      events.push(`publish:${pkg.id}`)
      const result = await onRun?.(call) ?? { status: 0 }
      if (result.status === 0 && !result.error && !invisible.includes(pkg.id)) {
        state.set(`${pkg.name}@${pkg.manifest.version}`, structuredClone(pkg.manifest))
      }
      return result
    },
  }
  return { dependencies, packages, state, calls, requests, events, logs }
}

function noCarrierPublication(sim) {
  assert.equal(sim.calls.some(call => call.pkg.id === 'carrier'), false, 'carrier publish must never be called')
}

test('default and explicit dry-run validate local manifests without any subprocess or fetch', async () => {
  for (const args of [[], ['--dry-run']]) {
    const sim = simulator()
    const result = await main(args, sim.dependencies)
    assert.equal(result.mode, 'dry-run')
    assert.deepEqual(result.planned, RELEASE_PACKAGES.map(pkg => pkg.name))
    assert.deepEqual(sim.events, [])
    assert.equal(sim.calls.length, 0)
    assert.equal(sim.requests.length, 0)
  }
})

test('help never invokes network, commands, or manifest loading', async () => {
  const sim = simulator()
  assert.deepEqual(await main(['--help'], { ...sim.dependencies, root: '/does-not-exist', packages: undefined }), { help: true })
  assert.deepEqual(sim.events, [])
  assert.match(sim.logs[0], /--publish/)
})

test('argument parsing fails closed on conflicting modes, unknown flags, and missing values', () => {
  assert.deepEqual(parseArgs([]), { mode: 'dry-run', registry: DEFAULT_REGISTRY })
  assert.deepEqual(parseArgs(['--check', '--version=0.3.0', '--registry', 'https://registry.example/npm']), {
    mode: 'check', version: '0.3.0', registry: 'https://registry.example/npm',
  })
  for (const args of [
    ['--check', '--publish'], ['--dry-run', '--publish'], ['--publish=false'],
    ['--registry'], ['--version', '--publish'], ['--version='],
    ['--registry', 'https://one.example', '--registry=https://two.example'],
  ]) assert.throws(() => parseArgs(args))
})

test('implementation publication is sequential and carrier follows a fresh registry gate', async () => {
  const sim = simulator()
  const result = await main(['--publish'], sim.dependencies)
  assert.deepEqual(sim.events, [
    'get:pi', 'get:tool', 'get:ui', 'get:carrier',
    'publish:pi', 'publish:tool', 'publish:ui',
    'get:pi', 'get:tool', 'get:ui',
    'publish:carrier',
    'get:pi', 'get:tool', 'get:ui', 'get:carrier',
  ])
  assert.deepEqual(result.published, RELEASE_PACKAGES.map(pkg => pkg.name))
  assert.deepEqual(result.skipped, [])
  for (const call of sim.calls) {
    assert.equal(call.command, 'npm')
    assert.deepEqual(call.args, [
      'publish', '--access', 'public', '--ignore-scripts',
      '--registry', DEFAULT_REGISTRY, `--@robiteame:registry=${DEFAULT_REGISTRY}`,
    ])
  }
})

for (const missing of ['pi', 'tool']) {
  test(`a missing ${missing} at the registry gate blocks carrier even after npm reports success`, async () => {
    const sim = simulator({ invisible: [missing] })
    await assert.rejects(main(['--publish'], sim.dependencies), new RegExp(`dsh-${missing === 'pi' ? 'pi-agent' : 'tool'}-session-tree@0.6.0: missing`))
    assert.deepEqual(sim.calls.map(call => call.pkg.id), ['pi', 'tool', 'ui'])
    noCarrierPublication(sim)
  })
}

test('an already published carrier does not hide missing implementation packages', async () => {
  const packages = fixtures()
  const sim = simulator({ packages, existing: [packages[2], packages[3]], invisible: ['pi', 'tool'] })
  await assert.rejects(main(['--publish'], sim.dependencies), /missing \(HTTP 404\)/)
  assert.deepEqual(sim.calls.map(call => call.pkg.id), ['pi', 'tool'])
  noCarrierPublication(sim)
})

test('existing same-name same-version packages are skipped, with gate and final checks retained', async () => {
  const packages = fixtures()
  const sim = simulator({ packages, existing: packages })
  const result = await main(['--publish'], sim.dependencies)
  assert.deepEqual(result.published, [])
  assert.deepEqual(result.skipped, packages.map(pkg => pkg.name))
  assert.equal(sim.calls.length, 0)
  assert.equal(sim.requests.length, 11)
})

test('partial releases resume with only missing packages in publication order', async () => {
  const packages = fixtures()
  const sim = simulator({ packages, existing: [packages[0], packages[2]] })
  await main(['--publish'], sim.dependencies)
  assert.deepEqual(sim.calls.map(call => call.pkg.id), ['tool', 'carrier'])
})

for (const status of [401, 403, 429, 500, 503]) {
  test(`registry HTTP ${status} fails preflight instead of being treated as a missing version`, async () => {
    const sim = simulator({ onFetch: ({ pkg }) => pkg.id === 'pi' ? response(undefined, status) : undefined })
    await assert.rejects(main(['--publish'], sim.dependencies), new RegExp(`registry HTTP ${status}`))
    assert.equal(sim.calls.length, 0)
    noCarrierPublication(sim)
  })
}

for (const failure of ['network', 'timeout', 'HTTP 503', 'JSON', 'name', 'version', 'range']) {
  test(`a ${failure} failure during the fresh implementation gate never invokes carrier publication`, async () => {
    const sim = simulator({
      onFetch: ({ pkg, count }) => {
        if (pkg.id !== 'tool' || count !== 2) return
        if (failure === 'network') throw new Error('ECONNRESET')
        if (failure === 'timeout') throw new Error('request timed out')
        if (failure === 'HTTP 503') return response(undefined, 503)
        if (failure === 'JSON') return { ok: true, status: 200, json: async () => { throw new Error('bad JSON') } }
        const manifest = structuredClone(pkg.manifest)
        if (failure === 'name') manifest.name = '@other/tool'
        if (failure === 'version') manifest.version = '0.5.0'
        if (failure === 'range') manifest.peerDependencies[RELEASE_PACKAGES[0].name] = '^0.3.0'
        return response(manifest)
      },
    })
    await assert.rejects(main(['--publish'], sim.dependencies), /Registry check failed/)
    noCarrierPublication(sim)
    assert.deepEqual(sim.calls.map(call => call.pkg.id), ['pi', 'tool', 'ui'])
  })
}

test('a registry network failure on preflight executes no npm commands', async () => {
  const sim = simulator({ onFetch: () => { throw new Error('ECONNRESET') } })
  await assert.rejects(main(['--publish'], sim.dependencies), /registry request failed: ECONNRESET/)
  assert.equal(sim.calls.length, 0)
})

for (const field of ['name', 'version']) {
  test(`an existing package with the wrong ${field} cannot be skipped as a successful publication`, async () => {
    const sim = simulator({
      onFetch: ({ pkg }) => pkg.id === 'pi' ? response({ ...pkg.manifest, [field]: field === 'name' ? '@wrong/pi' : '0.3.0' }) : undefined,
    })
    await assert.rejects(main(['--publish'], sim.dependencies), /expected the same name\/version/)
    assert.equal(sim.calls.length, 0)
  })
}

test('read-only check detects the historic carrier-and-ui-only 0.3.0 release', async () => {
  const historical = fixtures('0.3.0')
  const sim = simulator({ existing: [historical[2], historical[3]] })
  await assert.rejects(main(['--check', '--version', '0.3.0'], sim.dependencies), error => {
    assert.match(error.message, /dsh-pi-agent-session-tree@0.3.0: missing/)
    assert.match(error.message, /dsh-tool-session-tree@0.3.0: missing/)
    return true
  })
  assert.equal(sim.requests.length, 4)
  assert.ok(sim.requests.every(request => request.version === '0.3.0'))
  assert.equal(sim.calls.length, 0)
})

test('read-only check uses historical registry ranges instead of current local ranges', async () => {
  const historical = fixtures('0.3.0')
  const sim = simulator({ existing: historical })
  const result = await main(['--check', '--version=0.3.0'], sim.dependencies)
  assert.equal(result.version, '0.3.0')
  assert.equal(sim.requests.length, 4)
  assert.ok(sim.requests.every(request => request.version === '0.3.0'))
  assert.equal(sim.calls.length, 0)
})

test('check fails on incompatible published carrier and tool ranges', async () => {
  for (const id of ['tool', 'carrier']) {
    const packages = fixtures()
    const published = structuredClone(packages)
    const manifest = published.find(pkg => pkg.id === id).manifest
    const section = id === 'tool' ? 'peerDependencies' : 'dependencies'
    manifest[section][packages[0].name] = '^0.3.0'
    const sim = simulator({ packages, existing: published })
    await assert.rejects(main(['--check'], sim.dependencies), /does not match 0.6.0/)
    assert.equal(sim.calls.length, 0)
  }
})

test('custom registry, including a path prefix, is used for exact lookups and all publishes', async () => {
  const sim = simulator()
  const registry = 'https://registry.example/npm'
  const result = await main(['--publish', '--registry', registry], sim.dependencies)
  assert.equal(result.registry, `${registry}/`)
  for (const request of sim.requests) {
    assert.ok(request.url.startsWith(`${registry}/`))
    assert.equal(request.version, '0.6.0')
    assert.equal(request.options.method, 'GET')
    assert.equal(request.options.cache, 'no-store')
    assert.equal(request.options.redirect, 'error')
    assert.equal(request.options.headers.authorization, undefined)
  }
  for (const call of sim.calls) {
    assert.equal(call.args[call.args.indexOf('--registry') + 1], `${registry}/`)
    assert.equal(call.args.at(-1), `--@robiteame:registry=${registry}/`)
  }
})

test('local version and identity mismatches fail before any network request or subprocess', async () => {
  for (const mutation of [
    packages => { packages[0].manifest.version = '0.5.0' },
    packages => { packages[1].manifest.name = '@wrong/tool' },
    packages => { packages[2].manifest.private = true },
    packages => { delete packages[3].manifest.dependencies[packages[0].name] },
    packages => { delete packages[1].manifest.peerDependencies[packages[0].name] },
    packages => { packages[3].manifest.optionalDependencies = { [packages[0].name]: '^0.6.0' } },
  ]) {
    const sim = simulator()
    mutation(sim.packages)
    await assert.rejects(main(['--publish'], sim.dependencies))
    assert.deepEqual(sim.events, [])
  }
  const sim = simulator()
  await assert.rejects(main(['--publish', '--version=0.3.0'], sim.dependencies), /expected the same name\/version/)
  assert.deepEqual(sim.events, [])
})

test('standard npm semver ranges are supported and unsupported protocols fail closed', async () => {
  for (const range of ['^0.6.0', '~0.6.0', '0.6.0', '>=0.6.0 <0.7.0', '^0.3.0 || ^0.6.0']) {
    const sim = simulator()
    sim.packages[1].manifest.peerDependencies[sim.packages[0].name] = range
    await main([], sim.dependencies)
    assert.deepEqual(sim.events, [])
  }
  for (const range of ['^0.3.0', 'workspace:^', 'file:../pi', 'npm:other@0.6.0']) {
    const sim = simulator()
    sim.packages[1].manifest.peerDependencies[sim.packages[0].name] = range
    await assert.rejects(main(['--publish'], sim.dependencies), /range/)
    assert.deepEqual(sim.events, [])
  }
})

test('prerelease ranges follow standard npm semver behavior', async () => {
  const packages = fixtures('0.7.0-beta.1')
  const sim = simulator({ packages })
  await main([], sim.dependencies)
  packages[1].manifest.peerDependencies[packages[0].name] = '^0.7.0'
  await assert.rejects(main([], sim.dependencies), /does not match 0.7.0-beta.1/)
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
  for (const version of ['latest', '^0.6.0', '0.6', 'v0.6.0']) {
    const sim = simulator()
    await assert.rejects(main(['--check', '--version', version], sim.dependencies), /exact semver/)
    assert.deepEqual(sim.events, [])
  }
})

for (const failure of [{ status: 1 }, { status: null }, { status: 0, error: new Error('spawn failed') }]) {
  test(`npm failure (${failure.error?.message ?? failure.status}) aborts before ui and carrier`, async () => {
    const sim = simulator({ onRun: ({ pkg }) => pkg.id === 'tool' ? failure : undefined })
    await assert.rejects(main(['--publish'], sim.dependencies), /npm publish failed/)
    assert.deepEqual(sim.calls.map(call => call.pkg.id), ['pi', 'tool'])
    noCarrierPublication(sim)
  })
}

test('a missing carrier after successful npm publish fails the final four-package completeness check', async () => {
  const sim = simulator({ invisible: ['carrier'] })
  await assert.rejects(main(['--publish'], sim.dependencies), /dsh-session-tree@0.6.0: missing/)
  assert.deepEqual(sim.calls.map(call => call.pkg.id), ['pi', 'tool', 'ui', 'carrier'])
})

test('unknown programmatic modes fail closed instead of entering the publish branch', async () => {
  const sim = simulator()
  await assert.rejects(runRelease({ mode: 'typo' }, sim.dependencies), /Unknown release mode/)
  assert.deepEqual(sim.events, [])
})
