import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    OciRegistryClient,
    ReleaseApp,
    ReleaseApps,
    ReleaseDescriptorCodec,
    ReleaseManifest,
    ReleasePublishCli,
    ReleasePublisher,
    ReleaseRegistry,
    ReleaseTag,
    ReleaseVersionExistsError,
    type IComponentAssetSource,
    type OciFetch,
    type ReleaseCliOutput,
    type ReleaseManifestDocument,
} from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** The manifest breaks this repository's policy, names another release than the tag, or CI cannot check it. A fixed sentence followed by the offending value. */
export class PlatformReleaseManifestError extends Error
{
    private static readonly ErrorName = 'PlatformReleaseManifestError'

    public constructor(message: string)
    {
        super(message)
        this.name = PlatformReleaseManifestError.ErrorName
    }
}

/**
 * This repository's `release.json`: parsed by the toolkit's ReleaseManifest (schema 1, the release version, all nine apps
 * by digest), plus this repository's policy: every app comes from its own container repository of the organisation
 * (`pragmatic-tech-ai/<app>`, the repository its image is named after), and a release tag names the manifest's version.
 */
export class PlatformReleaseManifest
{
    public static readonly FileName = 'release.json'
    public static readonly TemplateFileName = 'release.template.json'
    public static readonly Organisation = ReleaseRegistry.DefaultNamespace
    private static readonly RepositorySeparator = '/'
    private static readonly Utf8 = 'utf8'
    private static readonly UnreadableMessage = 'The release manifest cannot be read: '
    private static readonly ForeignRepositoryPrefix = 'not released from its own container repository ('
    private static readonly ForeignRepositoryInfix = '): '
    private static readonly TagMismatchPrefix = 'The release tag does not name the manifest version: expected '
    private static readonly TagMismatchInfix = ', got '
    /**
     * The first platform admin console that renders the hive agent with its token as a mounted file and a readiness probe on
     * its ready file (pragmatic-shared 0.18.8), and the first agent that reads that file and writes it: a release pairing the
     * one with an older agent would leave every hive the console installs or updates without a running agent.
     */
    private static readonly FileTokenPlatformAdmin = '0.1.6'
    private static readonly FileTokenAgent = '0.1.2'
    private static readonly AgentTooOldPrefix = 'pragmatic-platform-admin '
    private static readonly AgentTooOldInfix = ' renders hive agents that need pragmatic-hive-agent '
    private static readonly AgentTooOldSuffix = ' or later (a token file and a ready file); this release pins '
    private static readonly VersionPattern = /^(\d+)\.(\d+)\.(\d+)/

    /** `pragmatic-tech-ai/<app>`: the container repository an app's image and component.json come from. */
    public static RepositoryOf(app: ReleaseApp): string
    {
        return PlatformReleaseManifest.Organisation + PlatformReleaseManifest.RepositorySeparator + app
    }

    /** Reads and parses the manifest at `path`, then holds it to the policy; throws a sentence for anything else. */
    public static Load(path: string): ReleaseManifestDocument
    {
        const S = PlatformReleaseManifest
        let text: string
        try
        {
            text = readFileSync(path, S.Utf8)
        }
        catch
        {
            throw new PlatformReleaseManifestError(S.UnreadableMessage + path)
        }
        const doc = ReleaseManifest.Parse(text)
        S.CheckPolicy(doc)
        return doc
    }

    /**
     * Every app names `pragmatic-tech-ai/<app>`, so no release is assembled from a fork's or another app's release; and the
     * platform admin console and the hive agent it renders fit together (FileTokenPlatformAdmin, FileTokenAgent).
     */
    public static CheckPolicy(doc: ReleaseManifestDocument): void
    {
        const S = PlatformReleaseManifest
        for (const app of ReleaseApps.All)
        {
            const expected = S.RepositoryOf(app)
            if (doc.components[app].repository !== expected)
            {
                throw new PlatformReleaseManifestError(S.ForeignRepositoryPrefix + expected + S.ForeignRepositoryInfix + app)
            }
        }
        const admin = doc.components[ReleaseApp.PlatformAdmin].version
        const agent = doc.components[ReleaseApp.HiveAgent].version
        if (S.AtLeast(admin, S.FileTokenPlatformAdmin) && !S.AtLeast(agent, S.FileTokenAgent))
        {
            throw new PlatformReleaseManifestError(S.AgentTooOldPrefix + admin + S.AgentTooOldInfix + S.FileTokenAgent + S.AgentTooOldSuffix + agent)
        }
    }

    // Whether `version` is at least `floor` by major, minor and patch (a prerelease counts as its release here).
    private static AtLeast(version: string, floor: string): boolean
    {
        const S = PlatformReleaseManifest
        const a = S.VersionPattern.exec(version)
        const b = S.VersionPattern.exec(floor)
        if (a === null || b === null) return false
        for (let i = 1; i <= 3; i += 1)
        {
            const d = Number(a[i]) - Number(b[i])
            if (d !== 0) return d > 0
        }
        return true
    }

    /** The tag (`release/<version>` or `refs/tags/release/<version>`) names the manifest's version; throws otherwise. */
    public static CheckTag(doc: ReleaseManifestDocument, ref: string): ReleaseTag
    {
        const tag = ReleaseTag.Parse(ref)
        if (tag.Version !== doc.version)
        {
            const S = PlatformReleaseManifest
            throw new PlatformReleaseManifestError(S.TagMismatchPrefix + ReleaseTag.Prefix + doc.version + S.TagMismatchInfix + ref)
        }
        return tag
    }
}

/**
 * The release registry as the toolkit's `pragmatic-release-publish` reads it from the environment (RELEASE_REGISTRY, default
 * ghcr.io; RELEASE_REGISTRY_USER and RELEASE_REGISTRY_TOKEN, required; RELEASE_NAMESPACE, when set, must be the
 * organisation the policy pins, since every app's repository is `pragmatic-tech-ai/<app>`), and what CI asks of it about
 * a manifest's version: published or not, and whether the published descriptor names the manifest's image digests. The
 * signature is not checked here (the platform console verifies it); CI only refuses a manifest whose image digests
 * changed after its version was published.
 */
export class PublishedRelease
{
    private static readonly EnvRegistry = 'RELEASE_REGISTRY'
    private static readonly EnvUser = 'RELEASE_REGISTRY_USER'
    private static readonly EnvToken = 'RELEASE_REGISTRY_TOKEN'
    private static readonly EnvNamespace = 'RELEASE_NAMESPACE'
    private static readonly SchemeMarker = '://'
    private static readonly MissingEnvPrefix = 'Missing required environment variable: '
    private static readonly VersionChangedPrefix = 'release.json differs from the published release '
    private static readonly ForeignNamespacePrefix = 'RELEASE_NAMESPACE must be the organisation the manifest policy pins ('
    private static readonly ForeignNamespaceInfix = '), not '
    private static readonly AppInfix = ': '

    private constructor(private readonly registry: OciRegistryClient, private readonly namespace: string)
    {
    }

    public static FromEnvironment(env: NodeJS.ProcessEnv, fetchFn?: OciFetch): PublishedRelease
    {
        const S = PublishedRelease
        const host = S.EnvOr(env, S.EnvRegistry, ReleaseRegistry.DefaultHost)
        const baseUrl = host.includes(S.SchemeMarker) ? host : ReleaseRegistry.HttpsScheme + host
        const namespace = S.EnvOr(env, S.EnvNamespace, PlatformReleaseManifest.Organisation)
        if (namespace !== PlatformReleaseManifest.Organisation)
        {
            throw new PlatformReleaseManifestError(S.ForeignNamespacePrefix + PlatformReleaseManifest.Organisation + S.ForeignNamespaceInfix + namespace)
        }
        const credential = { username: S.Env(env, S.EnvUser), token: S.Env(env, S.EnvToken) }
        return new PublishedRelease(new OciRegistryClient(baseUrl, fetchFn, credential), namespace)
    }

    /** True when `pragmatic-release:<version>` exists; registry failures throw. */
    public async IsPublished(version: string): Promise<boolean>
    {
        try
        {
            await new ReleasePublisher(this.registry, this.namespace).CheckVersionFree(version)
            return false
        }
        catch (error)
        {
            if (error instanceof ReleaseVersionExistsError)
            {
                return true
            }
            throw error
        }
    }

    /** The published descriptor of the manifest's version names exactly the manifest's image digests; throws naming the first app that differs. */
    public async CheckUnchanged(doc: ReleaseManifestDocument): Promise<void>
    {
        const S = PublishedRelease
        const repo = ReleaseRegistry.RepositoryPath(this.namespace, ReleasePublisher.DescriptorRepository)
        const { layer } = await this.registry.PullArtifactLayer(repo, doc.version)
        const images = new Map(ReleaseDescriptorCodec.ImagesOf(ReleaseDescriptorCodec.Decode(layer)))
        for (const app of ReleaseApps.All)
        {
            if (images.get(app)?.digest !== doc.components[app].digest)
            {
                throw new PlatformReleaseManifestError(S.VersionChangedPrefix + doc.version + S.AppInfix + app)
            }
        }
    }

    private static Env(env: NodeJS.ProcessEnv, name: string): string
    {
        const value = env[name]
        if (value === undefined || value.length === 0)
        {
            throw new PlatformReleaseManifestError(PublishedRelease.MissingEnvPrefix + name)
        }
        return value
    }

    private static EnvOr(env: NodeJS.ProcessEnv, name: string, fallback: string): string
    {
        const value = env[name]
        return value === undefined || value.length === 0 ? fallback : value
    }
}

/**
 * `verify [--manifest <path>] [--tag <ref>]`: the manifest parses, keeps the policy and (with a tag) is the tag's release;
 * offline. `ci [--manifest <path>]`: what CI checks on every push: no manifest is nothing to assemble; a manifest whose
 * version is published must name exactly the published descriptor's image digests (the last release); otherwise it
 * is assembled (checked against the registry and the container releases) by the toolkit's `pragmatic-release-publish
 * assemble`, which takes the same environment (RELEASE_REGISTRY_USER / _TOKEN, GITHUB_TOKEN). Signing and publishing are
 * release.yml's, through the toolkit command, never this tool's.
 */
export class ReleaseManifestCli
{
    private static readonly CommandVerify = 'verify'
    private static readonly CommandCi = 'ci'
    private static readonly FlagPrefix = '--'
    private static readonly FlagManifest = '--manifest'
    private static readonly FlagTag = '--tag'
    private static readonly PublishAssemble = 'assemble'
    private static readonly CommandFlags: ReadonlyMap<string, readonly string[]> = new Map([
        [ReleaseManifestCli.CommandVerify, [ReleaseManifestCli.FlagManifest, ReleaseManifestCli.FlagTag]],
        [ReleaseManifestCli.CommandCi, [ReleaseManifestCli.FlagManifest]],
    ])
    private static readonly UsageMessage = 'Usage: release-manifest verify [--manifest <path>] [--tag <ref>] | ci [--manifest <path>]'
    private static readonly UnknownFlagPrefix = 'Unknown option: '
    private static readonly MissingValuePrefix = 'Missing value for option: '
    private static readonly DuplicateFlagPrefix = 'Option given more than once: '
    private static readonly ReleaseLabel = 'release '
    private static readonly VerifiedInfix = ': '
    private static readonly AppsSuffix = ' apps, each from its own container repository'
    private static readonly TagInfix = ', tag '
    private static readonly NoManifestSuffix = ' is absent: nothing to assemble'
    private static readonly PublishedSuffix = ' is published and release.json names its image digests: nothing to assemble'
    private static readonly OkExitCode = 0
    private static readonly FailExitCode = 1

    /** `fetchFn` and `assets` replace the registry and GitHub (tests); `cwd` resolves the default manifest path. */
    public static async Run(argv: readonly string[], env: NodeJS.ProcessEnv, output: ReleaseCliOutput, cwd: string = process.cwd(),
        fetchFn?: OciFetch, assets?: IComponentAssetSource): Promise<number>
    {
        const S = ReleaseManifestCli
        try
        {
            const command = argv[0]
            const allowed = command === undefined ? undefined : S.CommandFlags.get(command)
            if (allowed === undefined)
            {
                throw new PlatformReleaseManifestError(S.UsageMessage)
            }
            const flags = S.ParseFlags(argv.slice(1), allowed)
            const path = resolve(cwd, flags.get(S.FlagManifest) ?? PlatformReleaseManifest.FileName)
            if (command === S.CommandVerify)
            {
                S.Verify(path, flags.get(S.FlagTag), output)
                return S.OkExitCode
            }
            return await S.Ci(path, env, output, fetchFn, assets)
        }
        catch (err)
        {
            output.Err(err instanceof Error ? err.message : String(err))
            return S.FailExitCode
        }
    }

    private static Verify(path: string, ref: string | undefined, output: ReleaseCliOutput): ReleaseManifestDocument
    {
        const S = ReleaseManifestCli
        const doc = PlatformReleaseManifest.Load(path)
        let line = S.ReleaseLabel + doc.version + S.VerifiedInfix + Object.keys(doc.components).length + S.AppsSuffix
        if (ref !== undefined)
        {
            line += S.TagInfix + ReleaseTag.Prefix + PlatformReleaseManifest.CheckTag(doc, ref).Version
        }
        output.Out(line)
        return doc
    }

    private static async Ci(path: string, env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: OciFetch, assets?: IComponentAssetSource): Promise<number>
    {
        const S = ReleaseManifestCli
        if (!existsSync(path))
        {
            output.Out(PlatformReleaseManifest.FileName + S.NoManifestSuffix)
            return S.OkExitCode
        }
        const doc = S.Verify(path, undefined, output)
        const published = PublishedRelease.FromEnvironment(env, fetchFn)
        if (await published.IsPublished(doc.version))
        {
            await published.CheckUnchanged(doc)
            output.Out(S.ReleaseLabel + doc.version + S.PublishedSuffix)
            return S.OkExitCode
        }
        return ReleasePublishCli.Run([S.PublishAssemble, S.FlagManifest, path], env, output, fetchFn, assets)
    }

    /** `--name value` pairs: an unknown or repeated name, or a missing value (absent, empty, or itself an option), is refused by name. */
    private static ParseFlags(args: readonly string[], allowed: readonly string[]): Map<string, string>
    {
        const S = ReleaseManifestCli
        const flags = new Map<string, string>()
        for (let i = 0; i < args.length; i += 2)
        {
            const name = args[i]
            const value = args[i + 1]
            if (!allowed.includes(name))
            {
                throw new PlatformReleaseManifestError(name.startsWith(S.FlagPrefix) ? S.UnknownFlagPrefix + name : S.UsageMessage)
            }
            if (flags.has(name))
            {
                throw new PlatformReleaseManifestError(S.DuplicateFlagPrefix + name)
            }
            if (value === undefined || value.length === 0 || value.startsWith(S.FlagPrefix))
            {
                throw new PlatformReleaseManifestError(S.MissingValuePrefix + name)
            }
            flags.set(name, value)
        }
        return flags
    }
}
