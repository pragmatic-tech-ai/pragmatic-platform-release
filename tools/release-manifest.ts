import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    ReleaseApps,
    ReleaseManifest,
    ReleasePublishCli,
    ReleaseRegistry,
    ReleaseTag,
    ReleaseVersionExistsError,
    type IComponentAssetSource,
    type OciFetch,
    type ReleaseApp,
    type ReleaseCliOutput,
    type ReleaseManifestDocument,
} from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** The manifest breaks this repository's policy, or names another release than the tag. One fixed sentence plus at most an app. */
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

    /** Every app names `pragmatic-tech-ai/<app>`, so no release is assembled from a fork's or another app's release. */
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
    }

    /** The tag (`release/<version>` or `refs/tags/release/<version>`) names the manifest's version; throws otherwise. */
    public static CheckTag(doc: ReleaseManifestDocument, ref: string): ReleaseTag
    {
        const tag = ReleaseTag.Parse(ref)
        if (tag.Version !== doc.version)
        {
            throw new PlatformReleaseManifestError(PlatformReleaseManifest.TagMismatchPrefix + ReleaseTag.Prefix + doc.version)
        }
        return tag
    }
}

/**
 * `verify [--manifest <path>] [--tag <ref>]`: the manifest parses, keeps the policy and (with a tag) is the tag's release;
 * offline. `ci [--manifest <path>]`: what CI checks on every push: no manifest is nothing to assemble; a manifest whose
 * version is already published is the last release (nothing to assemble); otherwise it is verified and then assembled
 * (checked against the registry and the container releases) by the toolkit's `pragmatic-release-publish assemble`, whose
 * environment it takes (RELEASE_REGISTRY_USER / _TOKEN, GITHUB_TOKEN). Signing and publishing are release.yml's,
 * through the toolkit command, never this tool's.
 */
export class ReleaseManifestCli
{
    private static readonly CommandVerify = 'verify'
    private static readonly CommandCi = 'ci'
    private static readonly FlagManifest = '--manifest'
    private static readonly FlagTag = '--tag'
    private static readonly PublishCheck = 'check'
    private static readonly PublishAssemble = 'assemble'
    private static readonly PublishFlagTag = '--tag'
    private static readonly PublishFlagManifest = '--manifest'
    private static readonly CommandFlags: ReadonlyMap<string, readonly string[]> = new Map([
        [ReleaseManifestCli.CommandVerify, [ReleaseManifestCli.FlagManifest, ReleaseManifestCli.FlagTag]],
        [ReleaseManifestCli.CommandCi, [ReleaseManifestCli.FlagManifest]],
    ])
    private static readonly UsageMessage = 'Usage: release-manifest verify [--manifest <path>] [--tag <ref>] | ci [--manifest <path>]'
    private static readonly ReleaseLabel = 'release '
    private static readonly VerifiedInfix = ': '
    private static readonly AppsSuffix = ' apps, each from its own container repository'
    private static readonly TagInfix = ', tag '
    private static readonly NoManifestSuffix = ' is absent: nothing to assemble'
    private static readonly PublishedSuffix = ' is published: nothing to assemble'
    private static readonly ErrorSeparator = ' / '
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
        if (await S.IsPublished(doc.version, env, fetchFn))
        {
            output.Out(S.ReleaseLabel + doc.version + S.PublishedSuffix)
            return S.OkExitCode
        }
        return ReleasePublishCli.Run([S.PublishAssemble, S.PublishFlagManifest, path], env, output, fetchFn, assets)
    }

    /**
     * The toolkit's `check --tag`: free answers 0; a published version is exactly the toolkit's ReleaseVersionExistsError
     * sentence; any other failure (registry unreachable, a credential missing) is printed and thrown as it is.
     */
    private static async IsPublished(version: string, env: NodeJS.ProcessEnv, fetchFn?: OciFetch): Promise<boolean>
    {
        const S = ReleaseManifestCli
        const errors: string[] = []
        const quiet: ReleaseCliOutput = { Out: () => undefined, Err: line => errors.push(line) }
        const code = await ReleasePublishCli.Run([S.PublishCheck, S.PublishFlagTag, ReleaseTag.Prefix + version], env, quiet, fetchFn)
        if (code === S.OkExitCode)
        {
            return false
        }
        const published = new ReleaseVersionExistsError(version).message
        if (errors.length === 1 && errors[0] === published)
        {
            return true
        }
        throw new PlatformReleaseManifestError(errors.join(S.ErrorSeparator))
    }

    private static ParseFlags(args: readonly string[], allowed: readonly string[]): Map<string, string>
    {
        const S = ReleaseManifestCli
        const flags = new Map<string, string>()
        for (let i = 0; i < args.length; i += 2)
        {
            const name = args[i]
            const value = args[i + 1]
            if (!allowed.includes(name) || value === undefined || value.length === 0 || flags.has(name))
            {
                throw new PlatformReleaseManifestError(S.UsageMessage)
            }
            flags.set(name, value)
        }
        return flags
    }
}
