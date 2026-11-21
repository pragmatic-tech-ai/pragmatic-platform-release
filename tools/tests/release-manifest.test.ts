import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    ReleaseApp,
    ReleaseApps,
    ReleaseManifestDigestError,
    ReleaseManifestMissingAppError,
    ReleaseManifestProblemKind,
    ReleaseManifestUnknownAppError,
    type IComponentAssetSource,
    type OciRequestInit,
} from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { PlatformReleaseManifest, PlatformReleaseManifestError, ReleaseManifestCli } from '../release-manifest.js'

/** No container repository has released anything: every asset and commit is absent. */
class NoAssets implements IComponentAssetSource
{
    public async ComponentAsset(): Promise<Uint8Array | undefined>
    {
        return undefined
    }

    public async ReleaseCommit(): Promise<string | undefined>
    {
        return undefined
    }
}

/** A registry in memory: HEAD of `pragmatic-release:<version>` answers as told, every other manifest is absent. */
class FakeRegistry
{
    private static readonly DescriptorPath = '/v2/pragmatic-tech-ai/pragmatic-release/manifests/'
    private static readonly DigestHeader = 'Docker-Content-Digest'
    private static readonly DescriptorDigest = 'sha256:' + 'd'.repeat(64)
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404

    public readonly Requests: string[] = []

    public constructor(private readonly published: ReadonlySet<string>, private readonly unreachable: boolean = false)
    {
    }

    public readonly Fetch = async (url: string, init: OciRequestInit): Promise<Response> =>
    {
        const S = FakeRegistry
        this.Requests.push(init.method + ' ' + url)
        if (this.unreachable)
        {
            throw new Error('connection refused')
        }
        const path = new URL(url).pathname
        if (path.startsWith(S.DescriptorPath) && this.published.has(path.slice(S.DescriptorPath.length)))
        {
            return new Response(null, { status: S.StatusOk, headers: { [S.DigestHeader]: S.DescriptorDigest } })
        }
        return new Response(null, { status: S.StatusNotFound })
    }
}

class ManifestFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Root = join(ManifestFixture.Here, '..', '..')
    public static readonly Template = join(ManifestFixture.Root, PlatformReleaseManifest.TemplateFileName)
    public static readonly Committed = join(ManifestFixture.Root, PlatformReleaseManifest.FileName)
    public static readonly Version = '0.1.0-early.6'
    public static readonly Digest = 'sha256:' + 'a'.repeat(64)
    public static readonly Placeholder = /^sha256:<[^>]+>$/
    public static readonly Env: NodeJS.ProcessEnv = { RELEASE_REGISTRY_USER: 'release-bot', RELEASE_REGISTRY_TOKEN: 'ghs_test_token' }
    public static readonly Utf8 = 'utf8'

    public readonly Dir = mkdtempSync(join(tmpdir(), 'platform-release-'))
    public readonly Out: string[] = []
    public readonly Err: string[] = []
    public readonly Output = { Out: (line: string) => { this.Out.push(line) }, Err: (line: string) => { this.Err.push(line) } }

    /** The template with every placeholder digest filled: what the coordinator commits as release.json. */
    public static Filled(): Record<string, unknown>
    {
        const doc = JSON.parse(readFileSync(ManifestFixture.Template, ManifestFixture.Utf8)) as { components: Record<string, { digest: string }> }
        for (const component of Object.values(doc.components))
        {
            component.digest = ManifestFixture.Digest
        }
        return doc
    }

    public Write(doc: unknown, name: string = PlatformReleaseManifest.FileName): string
    {
        const path = join(this.Dir, name)
        writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2))
        return path
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

describe('PlatformReleaseManifest', () =>
{
    const F = ManifestFixture

    it('loads a nine-app manifest, every app from its own container repository', () =>
    {
        const fixture = new F()
        try
        {
            const doc = PlatformReleaseManifest.Load(fixture.Write(F.Filled()))
            assert.equal(doc.version, F.Version)
            assert.deepEqual(Object.keys(doc.components).sort(), [...ReleaseApps.All].sort())
            for (const app of ReleaseApps.All)
            {
                assert.deepEqual(doc.components[app], { repository: 'pragmatic-tech-ai/' + app, version: '0.1.0', digest: F.Digest })
            }
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('refuses a missing app, an unknown app and a reference that is not a digest', () =>
    {
        const fixture = new F()
        try
        {
            const missing = F.Filled() as { components: Record<string, unknown> }
            delete missing.components[ReleaseApp.Postgres]
            assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(missing)), ReleaseManifestMissingAppError)
            const unknown = F.Filled() as { components: Record<string, unknown> }
            unknown.components['pragmatic-extra'] = { repository: 'pragmatic-tech-ai/pragmatic-extra', version: '0.1.0', digest: F.Digest }
            assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(unknown)), ReleaseManifestUnknownAppError)
            const tagged = F.Filled() as { components: Record<string, { digest: string }> }
            tagged.components[ReleaseApp.EnvServer].digest = '0.1.0'
            assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(tagged)), ReleaseManifestDigestError)
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('refuses an app released from another repository (a fork, or another app\'s repository)', () =>
    {
        const fixture = new F()
        try
        {
            const fork = F.Filled() as { components: Record<string, { repository: string }> }
            fork.components[ReleaseApp.TenantIdp].repository = 'someone-else/pragmatic-tenant-idp'
            assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(fork)), (err: Error) =>
                err instanceof PlatformReleaseManifestError && err.message.endsWith(ReleaseApp.TenantIdp))
            const swapped = F.Filled() as { components: Record<string, { repository: string }> }
            swapped.components[ReleaseApp.EnvGateway].repository = 'pragmatic-tech-ai/pragmatic-env-server'
            assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(swapped)), PlatformReleaseManifestError)
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('refuses an unreadable manifest with a sentence naming the path', () =>
    {
        const fixture = new F()
        try
        {
            const path = join(fixture.Dir, 'absent.json')
            assert.throws(() => PlatformReleaseManifest.Load(path), (err: Error) =>
                err instanceof PlatformReleaseManifestError && err.message.endsWith(path))
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('a release tag must name the manifest version', () =>
    {
        const fixture = new F()
        try
        {
            const doc = PlatformReleaseManifest.Load(fixture.Write(F.Filled()))
            assert.equal(PlatformReleaseManifest.CheckTag(doc, 'release/' + F.Version).Version, F.Version)
            assert.equal(PlatformReleaseManifest.CheckTag(doc, 'refs/tags/release/' + F.Version).Version, F.Version)
            assert.throws(() => PlatformReleaseManifest.CheckTag(doc, 'release/0.1.0-early.7'), PlatformReleaseManifestError)
            assert.throws(() => PlatformReleaseManifest.CheckTag(doc, 'v' + F.Version))
        }
        finally
        {
            fixture.Dispose()
        }
    })
})

describe('release.template.json', () =>
{
    const F = ManifestFixture

    it('is never a release: every digest is a placeholder the toolkit refuses', () =>
    {
        const template = JSON.parse(readFileSync(F.Template, F.Utf8)) as { components: Record<string, { digest: string }> }
        for (const component of Object.values(template.components))
        {
            assert.match(component.digest, F.Placeholder)
        }
        const fixture = new F()
        try
        {
            assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(readFileSync(F.Template, F.Utf8))), ReleaseManifestDigestError)
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('filled with digests, it is a valid manifest of all nine apps (only the digests are left to fill)', () =>
    {
        const fixture = new F()
        try
        {
            const doc = PlatformReleaseManifest.Load(fixture.Write(F.Filled()))
            assert.equal(Object.keys(doc.components).length, ReleaseApps.All.length)
        }
        finally
        {
            fixture.Dispose()
        }
    })
})

describe('release.json', () =>
{
    const F = ManifestFixture

    it('when committed, it loads and keeps the policy', (t) =>
    {
        if (!existsSync(F.Committed))
        {
            t.skip('no release.json committed (the coordinator fills it from release.template.json)')
            return
        }
        const doc = PlatformReleaseManifest.Load(F.Committed)
        assert.equal(Object.keys(doc.components).length, ReleaseApps.All.length)
    })
})

describe('release-manifest verify', () =>
{
    const F = ManifestFixture

    it('prints the release, and with a tag checks the tag names it', async () =>
    {
        const fixture = new F()
        try
        {
            fixture.Write(F.Filled())
            assert.equal(await ReleaseManifestCli.Run(['verify'], {}, fixture.Output, fixture.Dir), 0)
            assert.equal(await ReleaseManifestCli.Run(['verify', '--tag', 'refs/tags/release/' + F.Version], {}, fixture.Output, fixture.Dir), 0)
            assert.match(fixture.Out[1], /tag release\/0\.1\.0-early\.6$/)
            assert.equal(await ReleaseManifestCli.Run(['verify', '--tag', 'release/0.1.0-early.9'], {}, fixture.Output, fixture.Dir), 1)
            assert.equal(fixture.Err.length, 1)
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('fails without a release.json (a release tag on a commit without one cannot run)', async () =>
    {
        const fixture = new F()
        try
        {
            assert.equal(await ReleaseManifestCli.Run(['verify', '--tag', 'release/' + F.Version], {}, fixture.Output, fixture.Dir), 1)
            assert.equal(fixture.Out.length, 0)
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('refuses an unknown command, an unknown option and a missing option value', async () =>
    {
        const fixture = new F()
        try
        {
            assert.equal(await ReleaseManifestCli.Run([], {}, fixture.Output, fixture.Dir), 1)
            assert.equal(await ReleaseManifestCli.Run(['publish'], {}, fixture.Output, fixture.Dir), 1)
            assert.equal(await ReleaseManifestCli.Run(['verify', '--key-id', 'x'], {}, fixture.Output, fixture.Dir), 1)
            assert.equal(await ReleaseManifestCli.Run(['ci', '--tag', 'release/' + F.Version], {}, fixture.Output, fixture.Dir), 1)
            assert.equal(await ReleaseManifestCli.Run(['verify', '--manifest'], {}, fixture.Output, fixture.Dir), 1)
            assert.equal(fixture.Err.length, 5)
        }
        finally
        {
            fixture.Dispose()
        }
    })
})

describe('release-manifest ci', () =>
{
    const F = ManifestFixture

    it('passes without a release.json and asks nothing of the registry', async () =>
    {
        const fixture = new F()
        const registry = new FakeRegistry(new Set())
        try
        {
            assert.equal(await ReleaseManifestCli.Run(['ci'], F.Env, fixture.Output, fixture.Dir, registry.Fetch, new NoAssets()), 0)
            assert.match(fixture.Out[0], /absent/)
            assert.deepEqual(registry.Requests, [])
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('passes a manifest whose version is already published (the last release) without assembling it', async () =>
    {
        const fixture = new F()
        const registry = new FakeRegistry(new Set([F.Version]))
        try
        {
            fixture.Write(F.Filled())
            assert.equal(await ReleaseManifestCli.Run(['ci'], F.Env, fixture.Output, fixture.Dir, registry.Fetch, new NoAssets()), 0)
            assert.match(fixture.Out[1], /is published/)
            assert.equal(registry.Requests.length, 1)
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('assembles an unpublished manifest and fails on every problem the toolkit finds', async () =>
    {
        const fixture = new F()
        const registry = new FakeRegistry(new Set())
        try
        {
            fixture.Write(F.Filled())
            assert.equal(await ReleaseManifestCli.Run(['ci'], F.Env, fixture.Output, fixture.Dir, registry.Fetch, new NoAssets()), 1)
            for (const app of ReleaseApps.All)
            {
                assert.ok(fixture.Err.includes(app + ': ' + ReleaseManifestProblemKind.ImageMissing), app)
                assert.ok(fixture.Err.includes(app + ': ' + ReleaseManifestProblemKind.AssetMissing), app)
                assert.ok(fixture.Err.includes(app + ': ' + ReleaseManifestProblemKind.CommitMissing), app)
            }
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('fails, not skips, when the registry cannot say whether the version is published', async () =>
    {
        const fixture = new F()
        try
        {
            fixture.Write(F.Filled())
            const unreachable = new FakeRegistry(new Set(), true)
            assert.equal(await ReleaseManifestCli.Run(['ci'], F.Env, fixture.Output, fixture.Dir, unreachable.Fetch, new NoAssets()), 1)
            assert.equal(await ReleaseManifestCli.Run(['ci'], {}, fixture.Output, fixture.Dir, new FakeRegistry(new Set()).Fetch, new NoAssets()), 1)
            assert.ok(!fixture.Out.some(line => /published|assembles/.test(line)))
        }
        finally
        {
            fixture.Dispose()
        }
    })

    it('fails on an invalid release.json before asking the registry', async () =>
    {
        const fixture = new F()
        const registry = new FakeRegistry(new Set())
        try
        {
            fixture.Write(readFileSync(F.Template, F.Utf8))
            assert.equal(await ReleaseManifestCli.Run(['ci'], F.Env, fixture.Output, fixture.Dir, registry.Fetch, new NoAssets()), 1)
            assert.deepEqual(registry.Requests, [])
        }
        finally
        {
            fixture.Dispose()
        }
    })
})

/**
 * Where the release signing key may be read: this repository's release.yml and nowhere else among the organisation's
 * new repositories (the nine container repositories, pragmatic-e2e, pragmatic-shared's reusable workflows), read from
 * their clones beside this one when present. pragmatic-server still holds the key until it is archived (A3 Task 14).
 */
class Workflows
{
    public static readonly SigningKey = 'RELEASE_SIGNING_KEY'
    public static readonly SigningKeySecret = 'secrets.RELEASE_SIGNING_KEY'
    public static readonly Folder = join('.github', 'workflows')
    public static readonly Release = 'release.yml'
    public static readonly Ci = 'ci.yml'
    public static readonly Pattern = /\.ya?ml$/
    public static readonly Siblings: readonly string[] = [...ReleaseApps.All, 'pragmatic-e2e', 'pragmatic-shared']
    public static readonly Utf8 = 'utf8'

    /** Workflow file name to content, for the repository at `root` (empty when it has none). */
    public static Of(root: string): Map<string, string>
    {
        const dir = join(root, Workflows.Folder)
        const files = new Map<string, string>()
        if (!existsSync(dir))
        {
            return files
        }
        for (const name of readdirSync(dir))
        {
            if (Workflows.Pattern.test(name))
            {
                files.set(name, readFileSync(join(dir, name), Workflows.Utf8))
            }
        }
        return files
    }

    public static Text(name: string): string
    {
        return readFileSync(join(ManifestFixture.Root, Workflows.Folder, name), Workflows.Utf8)
    }

    /** The positions of `needles` in `text`, each found after the one before it; -1 for the first not found in order. */
    public static InOrder(text: string, needles: readonly string[]): number[]
    {
        const positions: number[] = []
        let from = 0
        for (const needle of needles)
        {
            const at = text.indexOf(needle, from)
            positions.push(at)
            if (at < 0)
            {
                break
            }
            from = at + needle.length
        }
        return positions
    }
}

describe('workflows', () =>
{
    const W = Workflows

    it('release.yml is the only workflow of this repository that reads RELEASE_SIGNING_KEY, once, as a secret', () =>
    {
        const readers = [...W.Of(ManifestFixture.Root)].filter(([, text]) => text.includes(W.SigningKey)).map(([name]) => name)
        assert.deepEqual(readers, [W.Release])
        assert.equal(W.Text(W.Release).split(W.SigningKeySecret).length - 1, 1)
    })

    it('release.yml is the only workflow in the organisation\'s new repositories that reads RELEASE_SIGNING_KEY', (t) =>
    {
        const parent = dirname(ManifestFixture.Root)
        const present = W.Siblings.filter(name => existsSync(join(parent, name, '.git')) || existsSync(join(parent, name, W.Folder)))
        if (present.length === 0)
        {
            t.skip('no sibling clone beside this repository')
            return
        }
        const readers: string[] = []
        for (const name of present)
        {
            for (const [file, text] of W.Of(join(parent, name)))
            {
                if (text.includes(W.SigningKey))
                {
                    readers.push(name + '/' + file)
                }
            }
        }
        assert.deepEqual(readers, [])
    })

    it('release.yml runs only on a release/* tag and verifies, assembles, then publishes from release.json', () =>
    {
        const text = W.Text(W.Release)
        assert.match(text, /on:\n {2}push:\n {4}tags: \['release\/\*'\]\n/)
        assert.doesNotMatch(text, /branches:|pull_request|workflow_dispatch/)
        const steps = W.InOrder(text, [
            'npm ci',
            'npm test',
            'tools/bin/release-manifest.ts verify --manifest release.json --tag "$GITHUB_REF"',
            'pragmatic-release-publish assemble --manifest release.json',
            W.SigningKeySecret,
            'pragmatic-release-publish publish --manifest release.json --key-id release-2026-11 --trust-dir release-keys',
        ])
        assert.ok(steps.every(at => at >= 0), JSON.stringify(steps))
    })

    it('ci.yml tests, then assembles release.json when there is one, with read-only package access', () =>
    {
        const text = W.Text(W.Ci)
        assert.ok(W.InOrder(text, ['npm ci', 'npm run typecheck', 'npm test', 'tools/bin/release-manifest.ts ci --manifest release.json']).every(at => at >= 0))
        assert.match(text, /packages: read/)
        assert.doesNotMatch(text, /packages: write/)
    })
})
