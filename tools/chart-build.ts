import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { GitHubComponentAssetSource, ReleaseApps, ReleaseManifest, type IComponentAssetSource, type ReleaseManifestDocument } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** The helm CLI calls the build makes (the real CLI; a recorder in tests). */
export interface IHelm
{
    /** `helm package <chart> --version <v> --app-version <v> -d <out>`; answers the package file. */
    Package(chartDir: string, version: string, outDir: string): string
    /** `helm push <package> oci://<repository base>`; answers the pushed manifest digest. */
    Push(packageFile: string, ociBase: string): string
}

/** The helm CLI on PATH. Its output names files and digests, never a credential (the login is the workflow's). */
export class HelmCli implements IHelm
{
    private static readonly Helm = 'helm'
    private static readonly Utf8 = 'utf8'
    private static readonly SavedPattern = /Successfully packaged chart and saved it to: (.+)$/m
    private static readonly DigestPattern = /Digest: (sha256:[0-9a-f]{64})/
    private static readonly NoPackage = 'helm package did not name the package it saved'
    private static readonly NoDigest = 'helm push did not report the pushed digest'
    private static readonly OciScheme = 'oci://'
    private static readonly PushFailed = 'helm push failed: '

    public Package(chartDir: string, version: string, outDir: string): string
    {
        const H = HelmCli
        const output = execFileSync(H.Helm, ['package', chartDir, '--version', version, '--app-version', version, '-d', outDir], { encoding: H.Utf8 })
        const saved = H.SavedPattern.exec(output)
        if (saved === null)
        {
            throw new Error(H.NoPackage)
        }
        return saved[1].trim()
    }

    public Push(packageFile: string, ociBase: string): string
    {
        const H = HelmCli
        // helm reports the pushed reference and digest on stderr: both streams are read.
        const result = spawnSync(H.Helm, ['push', packageFile, H.OciScheme + ociBase], { encoding: H.Utf8 })
        if (result.status !== 0)
        {
            throw new Error(H.PushFailed + (result.stderr ?? '').trim())
        }
        const digest = H.DigestPattern.exec((result.stdout ?? '') + (result.stderr ?? ''))
        if (digest === null)
        {
            throw new Error(H.NoDigest)
        }
        return digest[1]
    }
}

/** A manifest the chart cannot be built from (a missing app or digest): nothing was packaged or pushed. */
export class ChartBuildError extends Error
{
    private static readonly ErrorName = 'ChartBuildError'

    public constructor(message: string)
    {
        super(message)
        this.name = ChartBuildError.ErrorName
    }
}

/**
 * Builds the release's `pragmatic-engine` chart (C3.2 Task 4): a copy of charts/pragmatic-engine with every image digest
 * of the release manifest filled in (images.apps.<app>.digest), the release's component descriptors baked into
 * files/descriptors (each component's release asset, and digests.json of their content digests, as the console's
 * descriptor ConfigMap carries them), packaged at the release version and, with `push`, pushed to
 * oci://ghcr.io/<namespace>/charts. Answers the version and the pushed chart's manifest digest, which the signed release
 * descriptor binds (schema 3).
 */
export class ChartBuild
{
    public static readonly ChartName = 'pragmatic-engine'
    public static readonly DefaultChartDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'charts', ChartBuild.ChartName)
    public static readonly DescriptorsDir = join('files', 'descriptors')
    public static readonly DigestsFile = 'digests.json'
    public static readonly ValuesFile = 'values.yaml'
    private static readonly JsonSuffix = '.json'
    private static readonly ImagesKey = 'images'
    private static readonly AppsKey = 'apps'
    private static readonly DigestKey = 'digest'
    private static readonly RepositoryKey = 'repository'
    private static readonly Sha256Prefix = 'sha256:'
    private static readonly Hex = 'hex'
    private static readonly JsonIndent = 2
    private static readonly Eol = '\n'
    private static readonly NoDigestPrefix = 'the release manifest names no digest for '
    private static readonly NoAssetPrefix = 'no component descriptor asset for '
    private static readonly UnknownAppPrefix = 'the chart has no image entry for '
    private static readonly RepositoryMismatchPrefix = 'the chart pins another repository for '
    private static readonly ChartsSuffix = '/charts'
    private static readonly PathSeparator = '/'
    private static readonly DigestPattern = /^sha256:[0-9a-f]{64}$/
    private static readonly Utf8 = 'utf8'
    private static readonly Sha256 = 'sha256'

    public constructor(
        private readonly assets: IComponentAssetSource,
        private readonly helm: IHelm = new HelmCli(),
        private readonly chartDir: string = ChartBuild.DefaultChartDir)
    {
    }

    /** Stages, fills and packages the chart into `out`; pushes it under `ociBase` (`ghcr.io/<namespace>/charts`) when given. */
    public async Run(manifest: ReleaseManifestDocument, out: string, ociBase?: string): Promise<{ Version: string; Digest: string | undefined; Package: string }>
    {
        const C = ChartBuild
        const staged = join(out, C.ChartName)
        rmSync(staged, { recursive: true, force: true })
        mkdirSync(out, { recursive: true })
        cpSync(this.chartDir, staged, { recursive: true })
        C.FillDigests(join(staged, C.ValuesFile), manifest)
        await this.WriteDescriptors(join(staged, C.DescriptorsDir), manifest)
        const packageFile = this.helm.Package(staged, manifest.version, out)
        const digest = ociBase === undefined ? undefined : this.helm.Push(packageFile, ociBase)
        return { Version: manifest.version, Digest: digest, Package: packageFile }
    }

    /** `ghcr.io/<namespace>/charts`, the OCI base the chart is pushed under. */
    public static OciBaseOf(registryHost: string, namespace: string): string
    {
        return registryHost + ChartBuild.PathSeparator + namespace + ChartBuild.ChartsSuffix
    }

    /** Every app's digest into values.yaml (comments kept); a manifest missing one is refused before anything is written. */
    public static FillDigests(valuesFile: string, manifest: ReleaseManifestDocument): void
    {
        const C = ChartBuild
        const document = parseDocument(readFileSync(valuesFile, C.Utf8))
        for (const app of ReleaseApps.All)
        {
            const component = (manifest.components as Partial<ReleaseManifestDocument['components']>)[app]
            if (component === undefined || !C.DigestPattern.test(component.digest))
            {
                throw new ChartBuildError(C.NoDigestPrefix + app)
            }
            const path = [C.ImagesKey, C.AppsKey, app]
            const repository = document.getIn([...path, C.RepositoryKey])
            if (typeof repository !== 'string')
            {
                throw new ChartBuildError(C.UnknownAppPrefix + app)
            }
            if (repository !== component.repository)
            {
                throw new ChartBuildError(C.RepositoryMismatchPrefix + app)
            }
            document.setIn([...path, C.DigestKey], component.digest)
        }
        writeFileSync(valuesFile, document.toString())
    }

    /** Each component's descriptor (its release asset) and digests.json, into the chart's files/descriptors. */
    private async WriteDescriptors(dir: string, manifest: ReleaseManifestDocument): Promise<void>
    {
        const C = ChartBuild
        mkdirSync(dir, { recursive: true })
        const digests: Record<string, string> = {}
        for (const app of ReleaseApps.All)
        {
            const component = manifest.components[app]
            const asset = await this.assets.ComponentAsset(component.repository, component.version)
            if (asset === undefined)
            {
                throw new ChartBuildError(C.NoAssetPrefix + app)
            }
            writeFileSync(join(dir, app + C.JsonSuffix), asset)
            digests[app] = C.Sha256Prefix + createHash(C.Sha256).update(asset).digest(C.Hex)
        }
        writeFileSync(join(dir, C.DigestsFile), JSON.stringify(digests, undefined, C.JsonIndent) + C.Eol)
    }
}

/** `chart-build --manifest release.json --out <dir> [--push]`: the release workflow's chart step; prints `digest=<digest>`. */
export class ChartBuildCli
{
    private static readonly ManifestFlag = '--manifest'
    private static readonly OutFlag = '--out'
    private static readonly PushFlag = '--push'
    private static readonly RegistryHost = 'ghcr.io'
    private static readonly NamespaceEnv = 'RELEASE_NAMESPACE'
    private static readonly DefaultNamespace = 'pragmatic-tech-ai'
    private static readonly TokenEnv = 'GITHUB_TOKEN'
    private static readonly Usage = 'usage: chart-build --manifest <release.json> --out <dir> [--push]'
    private static readonly VersionPrefix = 'version='
    private static readonly DigestPrefix = 'digest='
    private static readonly PackagePrefix = 'package='
    private static readonly FailedPrefix = 'chart-build failed: '
    private static readonly Utf8 = 'utf8'

    private constructor()
    {
    }

    public static async Run(argv: readonly string[], env: NodeJS.ProcessEnv, out: { Out(line: string): void; Err(line: string): void }, assets?: IComponentAssetSource, helm?: IHelm): Promise<number>
    {
        const C = ChartBuildCli
        const manifestPath = C.Value(argv, C.ManifestFlag)
        const outDir = C.Value(argv, C.OutFlag)
        if (manifestPath === undefined || outDir === undefined)
        {
            out.Err(C.Usage)
            return 2
        }
        try
        {
            const manifest = ReleaseManifest.Parse(readFileSync(manifestPath, C.Utf8), env[C.NamespaceEnv] ?? C.DefaultNamespace)
            const namespace = env[C.NamespaceEnv] ?? C.DefaultNamespace
            const source = assets ?? new GitHubComponentAssetSource(undefined, env[C.TokenEnv])
            const base = argv.includes(C.PushFlag) ? ChartBuild.OciBaseOf(C.RegistryHost, namespace) : undefined
            const result = await new ChartBuild(source, helm).Run(manifest, outDir, base)
            out.Out(C.VersionPrefix + result.Version)
            out.Out(C.PackagePrefix + result.Package)
            if (result.Digest !== undefined)
            {
                out.Out(C.DigestPrefix + result.Digest)
            }
            return 0
        }
        catch (error)
        {
            out.Err(C.FailedPrefix + (error instanceof Error ? error.message : String(error)))
            return 1
        }
    }

    private static Value(argv: readonly string[], flag: string): string | undefined
    {
        const at = argv.indexOf(flag)
        return at < 0 ? undefined : argv[at + 1]
    }
}
