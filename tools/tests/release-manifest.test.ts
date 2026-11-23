import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    Channel,
    ComponentImageLabel,
    OciRegistryClient,
    ReleaseApp,
    ReleaseApps,
    ReleaseDescriptorCodec,
    ReleaseManifest,
    ReleaseManifestDigestError,
    ReleaseManifestInvalidError,
    ReleaseManifestMissingAppError,
    ReleaseManifestProblemKind,
    ReleaseManifestUnknownAppError,
    ReleasePublisher,
    ReleaseRegistry,
    ReleaseSignature,
    type IComponentAssetSource,
    type OciRequestInit,
    type ReleaseDescriptor,
} from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { PlatformReleaseManifest, PlatformReleaseManifestError, ReleaseManifestCli } from '../release-manifest.js'

/** The container releases in memory: each repository's v<version> component.json asset and tag commit, by `<repository>@<version>`. */
class FakeAssets implements IComponentAssetSource
{
    private static readonly KeySeparator = '@'

    public readonly Assets = new Map<string, Uint8Array>()
    public readonly Commits = new Map<string, string>()

    public static KeyOf(repository: string, version: string): string
    {
        return repository + FakeAssets.KeySeparator + version
    }

    public async ComponentAsset(repository: string, version: string): Promise<Uint8Array | undefined>
    {
        return this.Assets.get(FakeAssets.KeyOf(repository, version))
    }

    public async ReleaseCommit(repository: string, version: string): Promise<string | undefined>
    {
        return this.Commits.get(FakeAssets.KeyOf(repository, version))
    }
}

/**
 * A registry in memory: manifests by `<repo>:<reference>` (a tag or a digest) and blobs by `<repo>@<digest>`.
 * `pragmatic-release:<version>` answers with a signed schema-2 descriptor naming `digests` when the version is published;
 * PutImage adds a single-arch container image with a component label; anything else is absent; `unreachable` fails
 * every request.
 */
class FakeRegistry
{
    private static readonly ManifestsPattern = /^\/v2\/(.+)\/manifests\/([^/]+)$/
    private static readonly BlobsPattern = /^\/v2\/(.+)\/blobs\/([^/]+)$/
    private static readonly DescriptorRepo = ReleaseRegistry.RepositoryPath(PlatformReleaseManifest.Organisation, ReleasePublisher.DescriptorRepository)
    private static readonly DigestHeader = 'Docker-Content-Digest'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly ManifestType = 'application/vnd.oci.image.manifest.v1+json'
    private static readonly ConfigType = 'application/vnd.oci.image.config.v1+json'
    private static readonly LayerType = 'application/vnd.pragmatic.release.v1+json'
    private static readonly Commit = 'c'.repeat(40)
    private static readonly BuiltAt = '2026-11-21T10:00:00.000Z'
    private static readonly KeyId = 'release-2026-11'
    private static readonly MethodHead = 'HEAD'
    private static readonly Separator = ' '
    private static readonly TagSeparator = ':'
    private static readonly DigestSeparator = '@'
    private static readonly Unreachable = 'connection refused'
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404

    public readonly Requests: string[] = []
    private readonly manifests = new Map<string, Uint8Array>()
    private readonly blobs = new Map<string, Uint8Array>()

    public constructor(version: string | undefined, digests?: ReadonlyMap<ReleaseApp, string>, private readonly unreachable: boolean = false)
    {
        if (version !== undefined && digests !== undefined)
        {
            const layer = FakeRegistry.Descriptor(version, digests)
            this.PutManifest(FakeRegistry.DescriptorRepo, [version], { layers: [this.Blob(FakeRegistry.DescriptorRepo, layer, FakeRegistry.LayerType)], annotations: {} })
        }
    }

    /** A single-arch image of `app` labelled `label`, tagged each of `tags`; returns its manifest digest. */
    public PutImage(app: ReleaseApp, label: string, tags: readonly string[]): string
    {
        const repo = PlatformReleaseManifest.RepositoryOf(app)
        const config = new TextEncoder().encode(JSON.stringify({ config: { Labels: { [ComponentImageLabel.Name]: label } }, app }))
        return this.PutManifest(repo, tags, { config: this.Blob(repo, config, FakeRegistry.ConfigType), layers: [] })
    }

    public readonly Fetch = async (url: string, init: OciRequestInit): Promise<Response> =>
    {
        const S = FakeRegistry
        this.Requests.push(init.method + S.Separator + url)
        if (this.unreachable)
        {
            throw new Error(S.Unreachable)
        }
        const path = new URL(url).pathname
        const manifest = S.ManifestsPattern.exec(path)
        const bytes = manifest !== null ? this.manifests.get(manifest[1] + S.TagSeparator + manifest[2]) : undefined
        if (bytes !== undefined)
        {
            const headers = { [S.DigestHeader]: OciRegistryClient.DigestOf(bytes), [S.ContentTypeHeader]: S.ManifestType }
            return new Response(init.method === S.MethodHead ? null : new Uint8Array(bytes), { status: S.StatusOk, headers })
        }
        const blob = S.BlobsPattern.exec(path)
        const blobBytes = blob !== null ? this.blobs.get(blob[1] + S.DigestSeparator + blob[2]) : undefined
        if (blobBytes !== undefined)
        {
            return new Response(new Uint8Array(blobBytes), { status: S.StatusOk })
        }
        return new Response(null, { status: S.StatusNotFound })
    }

    /** Stores `bytes` as a blob of `repo`; returns its OCI descriptor. */
    private Blob(repo: string, bytes: Uint8Array, mediaType: string): { mediaType: string; digest: string; size: number }
    {
        const digest = OciRegistryClient.DigestOf(bytes)
        this.blobs.set(repo + FakeRegistry.DigestSeparator + digest, bytes)
        return { mediaType, digest, size: bytes.length }
    }

    /** Stores an image manifest of `repo` under its digest and each of `tags`; returns the digest. */
    private PutManifest(repo: string, tags: readonly string[], fields: Record<string, unknown>): string
    {
        const S = FakeRegistry
        const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, mediaType: S.ManifestType, ...fields }))
        const digest = OciRegistryClient.DigestOf(bytes)
        for (const reference of [digest, ...tags])
        {
            this.manifests.set(repo + S.TagSeparator + reference, bytes)
        }
        return digest
    }

    /** A schema-2 descriptor of `version` naming `digests`, signed with a throwaway key (Decode checks the shape only). */
    private static Descriptor(version: string, digests: ReadonlyMap<ReleaseApp, string>): Uint8Array
    {
        const S = FakeRegistry
        const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
        const images: Record<string, unknown> = {}
        for (const app of ReleaseApps.All)
        {
            const digest = digests.get(app) as string
            images[app] = { repository: PlatformReleaseManifest.RepositoryOf(app), digest, signature: ReleaseSignature.Sign(digest, key), componentDigest: digest }
        }
        const descriptor = {
            schema: ReleaseDescriptorCodec.CurrentSchema,
            version,
            channel: Channel.EarlyAccess,
            serverCommit: S.Commit,
            siblingCommits: {},
            builtAt: S.BuiltAt,
            signingKeyId: S.KeyId,
            images,
        } as unknown as ReleaseDescriptor
        return ReleaseDescriptorCodec.Encode(descriptor)
    }
}

class ManifestFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Root = join(ManifestFixture.Here, '..', '..')
    public static readonly Template = join(ManifestFixture.Root, PlatformReleaseManifest.TemplateFileName)
    public static readonly Committed = join(ManifestFixture.Root, PlatformReleaseManifest.FileName)
    public static readonly Organisation = 'pragmatic-tech-ai'
    public static readonly PathSeparator = '/'
    public static readonly Version = '0.1.0-early.6'
    public static readonly OtherVersion = '0.1.0-early.7'
    public static readonly ComponentVersion = '0.1.0'
    public static readonly Tag = 'release/' + ManifestFixture.Version
    public static readonly RefTag = 'refs/tags/' + ManifestFixture.Tag
    public static readonly OtherTag = 'release/' + ManifestFixture.OtherVersion
    public static readonly ContainerTag = 'v' + ManifestFixture.Version
    public static readonly Digest = 'sha256:' + 'a'.repeat(64)
    public static readonly DigestPrefixLength = 'sha256:'.length
    public static readonly CommitLength = 40
    public static readonly OtherDigest = 'sha256:' + 'b'.repeat(64)
    public static readonly Placeholder = /^sha256:<[^>]+>$/
    public static readonly TagSuffix = /tag release\/0\.1\.0-early\.6$/
    public static readonly Absent = /absent/
    public static readonly Published = /is published/
    public static readonly PublishedOrAssembled = /published|assembles/
    public static readonly Assembled = /^release 0\.1\.0-early\.6 assembles: 9 apps checked, no problems$/
    public static readonly UnreachableError = 'The OCI registry is unreachable'
    public static readonly DescriptorRequest = '/pragmatic-tech-ai/pragmatic-release/manifests/0.1.0-early.6'
    public static readonly MissingUserError = 'Missing required environment variable: RELEASE_REGISTRY_USER'
    public static readonly OtherNamespace = 'someone-else'
    public static readonly LineBreak = '\n'
    public static readonly ForeignAsset = 'a component.json of another build'
    public static readonly ProblemSeparator = ': '
    public static readonly AbsentFile = 'absent.json'
    public static readonly UnknownApp = 'pragmatic-extra'
    public static readonly ForkRepository = 'someone-else/pragmatic-tenant-idp'
    public static readonly Verify = 'verify'
    public static readonly Ci = 'ci'
    public static readonly FlagTag = '--tag'
    public static readonly FlagManifest = '--manifest'
    public static readonly FlagKeyId = '--key-id'
    public static readonly Publish = 'publish'
    public static readonly Env: NodeJS.ProcessEnv = { RELEASE_REGISTRY_USER: 'release-bot', RELEASE_REGISTRY_TOKEN: 'ghs_test_token' }
    public static readonly Utf8 = 'utf8'
    public static readonly NoReleaseJsonSkip = 'no release.json committed (the coordinator fills it from release.template.json)'
    public static readonly UnknownOption = 'Unknown option: '
    public static readonly MissingValue = 'Missing value for option: '
    public static readonly RepeatedOption = 'Option given more than once: '
    private static readonly TempPrefix = 'platform-release-'

    public readonly Dir = mkdtempSync(join(tmpdir(), ManifestFixture.TempPrefix))
    public readonly Out: string[] = []
    public readonly Err: string[] = []
    public readonly Output = { Out: (line: string) => { this.Out.push(line) }, Err: (line: string) => { this.Err.push(line) } }

    /** The template with every placeholder digest filled: what the coordinator commits as release.json. */
    public static Filled(): { components: Record<string, { repository: string; version: string; digest: string }> }
    {
        const doc = JSON.parse(readFileSync(ManifestFixture.Template, ManifestFixture.Utf8)) as { components: Record<string, { repository: string; version: string; digest: string }> }
        for (const component of Object.values(doc.components))
        {
            component.digest = ManifestFixture.Digest
        }
        return doc
    }

    /** Every app at `digest`: the digests a published descriptor names. */
    public static Digests(digest: string = ManifestFixture.Digest): Map<ReleaseApp, string>
    {
        return new Map(ReleaseApps.All.map(app => [app, digest]))
    }

    /**
     * Releases all nine container repositories into `registry` and `assets` as container-release.yml does (component.json
     * asset and tag commit; the image labelled with the asset's digest and tagged `<version>` and `git-<commit>`); the
     * image of `mislabelled` carries the digest of another component.json. Returns the manifest naming the nine images.
     */
    public static Released(registry: FakeRegistry, assets: FakeAssets, mislabelled?: ReleaseApp): ReturnType<typeof ManifestFixture.Filled>
    {
        const F = ManifestFixture
        const doc = F.Filled()
        for (const app of ReleaseApps.All)
        {
            const repository = PlatformReleaseManifest.RepositoryOf(app)
            const asset = new TextEncoder().encode(JSON.stringify({ component: app, version: F.ComponentVersion, settings: [] }))
            const commit = OciRegistryClient.DigestOf(new TextEncoder().encode(app)).slice(F.DigestPrefixLength, F.DigestPrefixLength + F.CommitLength)
            assets.Assets.set(FakeAssets.KeyOf(repository, F.ComponentVersion), asset)
            assets.Commits.set(FakeAssets.KeyOf(repository, F.ComponentVersion), commit)
            const label = OciRegistryClient.DigestOf(app === mislabelled ? new TextEncoder().encode(F.ForeignAsset) : asset)
            doc.components[app].digest = registry.PutImage(app, label, [F.ComponentVersion, ReleaseManifest.CommitTagOf(commit)])
        }
        return doc
    }

    public static Problem(app: ReleaseApp, kind: ReleaseManifestProblemKind): string
    {
        return app + ManifestFixture.ProblemSeparator + kind
    }

    public Write(doc: unknown, name: string = PlatformReleaseManifest.FileName): string
    {
        const path = join(this.Dir, name)
        writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2))
        return path
    }

    /** Runs the CLI in this fixture's folder; with no `assets`, no container repository has released anything. */
    public Run(argv: readonly string[], env: NodeJS.ProcessEnv = {}, registry?: FakeRegistry, assets: FakeAssets = new FakeAssets()): Promise<number>
    {
        return ReleaseManifestCli.Run(argv, env, this.Output, this.Dir, registry?.Fetch, assets)
    }

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }

    /** Runs `body` with a fresh fixture and always removes its folder. */
    public static async With(body: (fixture: ManifestFixture) => void | Promise<void>): Promise<void>
    {
        const fixture = new ManifestFixture()
        try
        {
            await body(fixture)
        }
        finally
        {
            fixture.Dispose()
        }
    }
}

describe('PlatformReleaseManifest', () =>
{
    const F = ManifestFixture

    it('loads a nine-app manifest, every app from its own container repository', () => F.With(fixture =>
    {
        const doc = PlatformReleaseManifest.Load(fixture.Write(F.Filled()))
        assert.equal(doc.version, F.Version)
        assert.deepEqual(Object.keys(doc.components).sort(), [...ReleaseApps.All].sort())
        for (const app of ReleaseApps.All)
        {
            assert.deepEqual(doc.components[app], { repository: PlatformReleaseManifest.RepositoryOf(app), version: F.ComponentVersion, digest: F.Digest })
            assert.equal(PlatformReleaseManifest.RepositoryOf(app), F.Organisation + F.PathSeparator + app)
        }
    }))

    it('refuses a missing app, an unknown app and a reference that is not a digest', () => F.With(fixture =>
    {
        const missing = F.Filled()
        delete missing.components[ReleaseApp.Postgres]
        assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(missing)), ReleaseManifestMissingAppError)
        const unknown = F.Filled()
        unknown.components[F.UnknownApp] = { repository: F.Organisation + F.PathSeparator + F.UnknownApp, version: F.ComponentVersion, digest: F.Digest }
        assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(unknown)), ReleaseManifestUnknownAppError)
        const tagged = F.Filled()
        tagged.components[ReleaseApp.EnvServer].digest = F.ComponentVersion
        assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(tagged)), ReleaseManifestDigestError)
    }))

    it('refuses an app released from another repository (a fork, or another app\'s repository)', () => F.With(fixture =>
    {
        const fork = F.Filled()
        fork.components[ReleaseApp.TenantIdp].repository = F.ForkRepository
        assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(fork)), (err: Error) =>
            err instanceof ReleaseManifestInvalidError && err.message.endsWith(ReleaseApp.TenantIdp))
        const swapped = F.Filled()
        swapped.components[ReleaseApp.EnvGateway].repository = PlatformReleaseManifest.RepositoryOf(ReleaseApp.EnvServer)
        assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(swapped)), ReleaseManifestInvalidError)
    }))

    it('refuses an unreadable manifest with a sentence naming the path', () => F.With(fixture =>
    {
        const path = join(fixture.Dir, F.AbsentFile)
        assert.throws(() => PlatformReleaseManifest.Load(path), (err: Error) =>
            err instanceof PlatformReleaseManifestError && err.message.endsWith(path))
    }))

    it('a release tag must name the manifest version', () => F.With(fixture =>
    {
        const doc = PlatformReleaseManifest.Load(fixture.Write(F.Filled()))
        assert.equal(PlatformReleaseManifest.CheckTag(doc, F.Tag).Version, F.Version)
        assert.equal(PlatformReleaseManifest.CheckTag(doc, F.RefTag).Version, F.Version)
        assert.throws(() => PlatformReleaseManifest.CheckTag(doc, F.OtherTag), (err: Error) =>
            err instanceof PlatformReleaseManifestError && err.message.includes(F.Tag) && err.message.endsWith(F.OtherTag))
        assert.throws(() => PlatformReleaseManifest.CheckTag(doc, F.ContainerTag))
    }))
})

describe('release.template.json', () =>
{
    const F = ManifestFixture

    it('is never a release: every digest is a placeholder the toolkit refuses', () => F.With(fixture =>
    {
        const template = JSON.parse(readFileSync(F.Template, F.Utf8)) as { components: Record<string, { digest: string }> }
        assert.equal(Object.keys(template.components).length, ReleaseApps.All.length)
        for (const component of Object.values(template.components))
        {
            assert.match(component.digest, F.Placeholder)
        }
        assert.throws(() => PlatformReleaseManifest.Load(fixture.Write(readFileSync(F.Template, F.Utf8))), ReleaseManifestDigestError)
    }))

    it('filled with digests, it is a valid manifest of all nine apps (only the digests are left to fill)', () => F.With(fixture =>
    {
        const doc = PlatformReleaseManifest.Load(fixture.Write(F.Filled()))
        assert.equal(Object.keys(doc.components).length, ReleaseApps.All.length)
    }))
})

describe('release.json', () =>
{
    const F = ManifestFixture

    it('when committed, it loads and keeps the policy', (t) =>
    {
        if (!existsSync(F.Committed))
        {
            t.skip(F.NoReleaseJsonSkip)
            return
        }
        const doc = PlatformReleaseManifest.Load(F.Committed)
        assert.equal(Object.keys(doc.components).length, ReleaseApps.All.length)
    })
})

describe('release-manifest verify', () =>
{
    const F = ManifestFixture

    it('prints the release, and with a tag checks the tag names it', () => F.With(async fixture =>
    {
        fixture.Write(F.Filled())
        assert.equal(await fixture.Run([F.Verify]), 0)
        assert.equal(await fixture.Run([F.Verify, F.FlagTag, F.RefTag]), 0)
        assert.match(fixture.Out[1], F.TagSuffix)
        assert.equal(await fixture.Run([F.Verify, F.FlagTag, F.OtherTag]), 1)
        assert.equal(fixture.Err.length, 1)
    }))

    it('fails without a release.json (a release tag on a commit without one cannot run)', () => F.With(async fixture =>
    {
        assert.equal(await fixture.Run([F.Verify, F.FlagTag, F.Tag]), 1)
        assert.equal(fixture.Out.length, 0)
    }))

    it('refuses an unknown command, an unknown or repeated option and a missing value, naming the option', () => F.With(async fixture =>
    {
        fixture.Write(F.Filled())
        assert.equal(await fixture.Run([]), 1)
        assert.equal(await fixture.Run([F.Publish]), 1)
        assert.equal(await fixture.Run([F.Verify, F.FlagKeyId, F.Version]), 1)
        assert.equal(fixture.Err[2], F.UnknownOption + F.FlagKeyId)
        assert.equal(await fixture.Run([F.Ci, F.FlagTag, F.Tag]), 1)
        assert.equal(fixture.Err[3], F.UnknownOption + F.FlagTag)
        assert.equal(await fixture.Run([F.Verify, F.FlagManifest]), 1)
        assert.equal(fixture.Err[4], F.MissingValue + F.FlagManifest)
        assert.equal(await fixture.Run([F.Verify, F.FlagTag, F.FlagManifest]), 1)
        assert.equal(fixture.Err[5], F.MissingValue + F.FlagTag)
        assert.equal(await fixture.Run([F.Verify, F.FlagTag, F.Tag, F.FlagTag, F.Tag]), 1)
        assert.equal(fixture.Err[6], F.RepeatedOption + F.FlagTag)
        assert.equal(fixture.Out.length, 0)
    }))
})

describe('release-manifest ci', () =>
{
    const F = ManifestFixture

    it('passes without a release.json and asks nothing of the registry', () => F.With(async fixture =>
    {
        const registry = new FakeRegistry(undefined)
        assert.equal(await fixture.Run([F.Ci], F.Env, registry), 0)
        assert.match(fixture.Out[0], F.Absent)
        assert.deepEqual(registry.Requests, [])
    }))

    it('passes a published version whose descriptor names the manifest digests (the last release) without assembling it', () => F.With(async fixture =>
    {
        const registry = new FakeRegistry(F.Version, F.Digests())
        fixture.Write(F.Filled())
        assert.equal(await fixture.Run([F.Ci], F.Env, registry), 0)
        assert.match(fixture.Out[1], F.Published)
        assert.equal(fixture.Err.length, 0)
    }))

    it('fails a published version whose release.json was changed afterwards, naming the app', () => F.With(async fixture =>
    {
        const digests = F.Digests()
        digests.set(ReleaseApp.HiveAgent, F.OtherDigest)
        fixture.Write(F.Filled())
        assert.equal(await fixture.Run([F.Ci], F.Env, new FakeRegistry(F.Version, digests)), 1)
        assert.equal(fixture.Err.length, 1)
        assert.ok(fixture.Err[0].endsWith(ReleaseApp.HiveAgent), fixture.Err[0])
    }))

    it('assembles an unpublished manifest and fails on every problem the toolkit finds', () => F.With(async fixture =>
    {
        fixture.Write(F.Filled())
        assert.equal(await fixture.Run([F.Ci], F.Env, new FakeRegistry(undefined)), 1)
        for (const app of ReleaseApps.All)
        {
            assert.ok(fixture.Err.includes(F.Problem(app, ReleaseManifestProblemKind.ImageMissing)), app)
            assert.ok(fixture.Err.includes(F.Problem(app, ReleaseManifestProblemKind.AssetMissing)), app)
            assert.ok(fixture.Err.includes(F.Problem(app, ReleaseManifestProblemKind.CommitMissing)), app)
        }
    }))

    it('assembles a manifest of nine released images (each labelled with its component.json, tagged by version and commit)', () => F.With(async fixture =>
    {
        const registry = new FakeRegistry(undefined)
        const assets = new FakeAssets()
        fixture.Write(F.Released(registry, assets))
        assert.equal(await fixture.Run([F.Ci], F.Env, registry, assets), 0, fixture.Err.join(F.LineBreak))
        assert.match(fixture.Out[fixture.Out.length - 1], F.Assembled)
        assert.deepEqual(fixture.Err, [])
    }))

    it('reports an image whose component label is not the digest of its repository\'s component.json', () => F.With(async fixture =>
    {
        const registry = new FakeRegistry(undefined)
        const assets = new FakeAssets()
        fixture.Write(F.Released(registry, assets, ReleaseApp.TenantIdp))
        assert.equal(await fixture.Run([F.Ci], F.Env, registry, assets), 1)
        assert.deepEqual(fixture.Err, [F.Problem(ReleaseApp.TenantIdp, ReleaseManifestProblemKind.AssetMismatch)])
    }))

    it('fails, not skips, when the registry is unreachable', () => F.With(async fixture =>
    {
        const registry = new FakeRegistry(undefined, undefined, true)
        fixture.Write(F.Filled())
        assert.equal(await fixture.Run([F.Ci], F.Env, registry), 1)
        assert.deepEqual(fixture.Err, [F.UnreachableError])
        assert.ok(registry.Requests.length > 0 && registry.Requests.every(line => line.includes(F.DescriptorRequest)), registry.Requests.join(F.LineBreak))
        assert.ok(!fixture.Out.some(line => F.PublishedOrAssembled.test(line)))
    }))

    it('fails without registry credentials, naming the variable, before asking the registry', () => F.With(async fixture =>
    {
        const registry = new FakeRegistry(undefined)
        fixture.Write(F.Filled())
        assert.equal(await fixture.Run([F.Ci], {}, registry), 1)
        assert.deepEqual(fixture.Err, [F.MissingUserError])
        assert.deepEqual(registry.Requests, [])
    }))

    it('refuses a RELEASE_NAMESPACE other than the organisation the policy pins, before asking the registry', () => F.With(async fixture =>
    {
        const registry = new FakeRegistry(undefined)
        fixture.Write(F.Filled())
        assert.equal(await fixture.Run([F.Ci], { ...F.Env, RELEASE_NAMESPACE: F.OtherNamespace }, registry), 1)
        assert.equal(fixture.Err.length, 1)
        assert.ok(fixture.Err[0].endsWith(F.OtherNamespace), fixture.Err[0])
        assert.deepEqual(registry.Requests, [])
        assert.equal(await fixture.Run([F.Ci], { ...F.Env, RELEASE_NAMESPACE: F.Organisation }, new FakeRegistry(undefined)), 1)
        assert.ok(fixture.Err.includes(F.Problem(ReleaseApp.Postgres, ReleaseManifestProblemKind.ImageMissing)))
    }))

    it('fails on an invalid release.json before asking the registry', () => F.With(async fixture =>
    {
        const registry = new FakeRegistry(undefined)
        fixture.Write(readFileSync(F.Template, F.Utf8))
        assert.equal(await fixture.Run([F.Ci], F.Env, registry), 1)
        assert.deepEqual(registry.Requests, [])
    }))
})

/**
 * Where the release signing key may be read: this repository's release.yml and nowhere else among the organisation's
 * new repositories (the nine container repositories, pragmatic-e2e, pragmatic-shared's reusable workflows), read from
 * their clones beside this one (or under PLATFORM_SIBLINGS_ROOT) when present. pragmatic-server still holds the key
 * until it is archived (A3 Task 14).
 */
class Workflows
{
    public static readonly SigningKey = 'RELEASE_SIGNING_KEY'
    public static readonly SigningKeySecret = 'secrets.RELEASE_SIGNING_KEY'
    public static readonly Folder = join('.github', 'workflows')
    public static readonly GitFolder = '.git'
    public static readonly Release = 'release.yml'
    public static readonly Ci = 'ci.yml'
    public static readonly Pattern = /\.ya?ml$/
    public static readonly Comment = /^\s*#/
    public static readonly LineBreak = '\n'
    public static readonly PathSeparator = '/'
    public static readonly ListSeparator = ', '
    public static readonly CheckedPrefix = 'checked: '
    public static readonly EnvSiblingsRoot = 'PLATFORM_SIBLINGS_ROOT'
    public static readonly Siblings: readonly string[] = [...ReleaseApps.All, 'pragmatic-e2e', 'pragmatic-shared']
    public static readonly PlatformAdmin = ReleaseApp.PlatformAdmin
    public static readonly KeysFolder = 'release-keys'
    public static readonly KeyFile = 'release-2026-11.pub.pem'
    public static readonly TagTrigger = /on:\n {2}push:\n {4}tags: \['release\/\*'\]\n/
    public static readonly OtherTriggers = /branches:|pull_request|workflow_dispatch|workflow_call/
    public static readonly Environment = /\n {4}environment: release\n/
    public static readonly OneReleaseAtATime = /\nconcurrency:\n {2}group: platform-release\n {2}cancel-in-progress: false\n/
    public static readonly IgnoreScripts = '--ignore-scripts'
    public static readonly NpmCi = 'npm ci'
    public static readonly ReadPackages = /packages: read/
    public static readonly WritePackages = /packages: write/
    public static readonly ReleaseSteps: readonly string[] = [
        'ref: ${{ github.sha }}',
        'npm ci --ignore-scripts',
        'npm run typecheck',
        'npm test',
        'tools/bin/release-manifest.ts verify --manifest release.json --tag "$GITHUB_REF"',
        'publish:',
        'environment: release',
        'ref: ${{ github.sha }}',
        'npm ci --omit=dev --ignore-scripts',
        'pragmatic-release-publish assemble --manifest release.json',
        'secrets.RELEASE_SIGNING_KEY',
        '::error::RELEASE_SIGNING_KEY is empty',
        'pragmatic-release-publish publish --manifest release.json --key-id release-2026-11 --trust-dir release-keys',
        'if: always()',
        'rm -f "$RUNNER_TEMP/release.key"',
    ]
    public static readonly CiSteps: readonly string[] = [
        'npm ci --ignore-scripts',
        'npm run typecheck',
        'npm test',
        'tools/bin/release-manifest.ts ci --manifest release.json',
        'tools/bin/signing-key-readers.ts',
    ]
    public static readonly Utf8 = 'utf8'
    public static readonly NoSiblingsSkip = 'no sibling clone in '
    public static readonly SetVariableInfix = ' (set '
    public static readonly SetVariableSuffix = ')'
    public static readonly NoPlatformAdminSkip = 'no pragmatic-platform-admin clone with '

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

    /** The workflow without its comment lines: what steps and triggers are matched against. */
    public static Code(name: string): string
    {
        return Workflows.Text(name).split(Workflows.LineBreak).filter(line => !Workflows.Comment.test(line)).join(Workflows.LineBreak)
    }

    /** The folder the sibling clones sit in: PLATFORM_SIBLINGS_ROOT, else this repository's parent folder. */
    public static SiblingsRoot(): string
    {
        const configured = process.env[Workflows.EnvSiblingsRoot]
        return configured === undefined || configured.length === 0 ? dirname(ManifestFixture.Root) : configured
    }

    public static Present(root: string): string[]
    {
        return Workflows.Siblings.filter(name => existsSync(join(root, name, Workflows.GitFolder)) || existsSync(join(root, name, Workflows.Folder)))
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
        assert.equal(W.Code(W.Release).split(W.SigningKeySecret).length - 1, 1)
    })

    it('release.yml is the only workflow in the organisation\'s new repositories that reads RELEASE_SIGNING_KEY', (t) =>
    {
        const root = W.SiblingsRoot()
        const present = W.Present(root)
        if (present.length === 0)
        {
            t.skip(W.NoSiblingsSkip + root + W.SetVariableInfix + W.EnvSiblingsRoot + W.SetVariableSuffix)
            return
        }
        t.diagnostic(W.CheckedPrefix + present.join(W.ListSeparator))
        const readers: string[] = []
        for (const name of present)
        {
            for (const [file, text] of W.Of(join(root, name)))
            {
                if (text.includes(W.SigningKey))
                {
                    readers.push(name + W.PathSeparator + file)
                }
            }
        }
        assert.deepEqual(readers, [])
    })

    it('the release key is the one pragmatic-platform-admin verifies against, when its clone is beside this one', (t) =>
    {
        const theirs = join(W.SiblingsRoot(), W.PlatformAdmin, W.KeysFolder, W.KeyFile)
        if (!existsSync(theirs))
        {
            t.skip(W.NoPlatformAdminSkip + W.KeysFolder)
            return
        }
        assert.equal(readFileSync(join(ManifestFixture.Root, W.KeysFolder, W.KeyFile), W.Utf8), readFileSync(theirs, W.Utf8))
    })

    it('release.yml runs only on a release/* tag, one run at a time: verify, then publish in the release environment', () =>
    {
        const code = W.Code(W.Release)
        assert.match(code, W.TagTrigger)
        assert.doesNotMatch(code, W.OtherTriggers)
        assert.match(code, W.Environment)
        assert.match(code, W.OneReleaseAtATime)
        const steps = W.InOrder(code, W.ReleaseSteps)
        assert.ok(steps.every(at => at >= 0), JSON.stringify(steps))
    })

    it('ci.yml tests, then checks release.json, with read-only package access', () =>
    {
        const code = W.Code(W.Ci)
        const steps = W.InOrder(code, W.CiSteps)
        assert.ok(steps.every(at => at >= 0), JSON.stringify(steps))
        assert.match(code, W.ReadPackages)
        assert.doesNotMatch(code, W.WritePackages)
    })

    it('every install runs with --ignore-scripts', () =>
    {
        for (const name of [W.Release, W.Ci])
        {
            const installs = W.Code(name).split(W.LineBreak).filter(line => line.includes(W.NpmCi))
            assert.ok(installs.length > 0, name)
            assert.ok(installs.every(line => line.includes(W.IgnoreScripts)), name)
        }
    })
})
