import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ReleaseApp, ReleaseApps, ReleaseManifest, type IComponentAssetSource, type ReleaseManifestDocument } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ChartBuild, ChartBuildCli, ChartBuildError, type IHelm } from '../chart-build.js'

class FixtureAssets implements IComponentAssetSource
{
    public readonly Asked: string[] = []

    public constructor(private readonly missing?: ReleaseApp)
    {
    }

    public async ComponentAsset(repository: string, version: string): Promise<Uint8Array | undefined>
    {
        this.Asked.push(repository + '@' + version)
        const app = repository.split('/')[1]
        return app === this.missing ? undefined : new TextEncoder().encode(JSON.stringify({ component: app, version }))
    }

    public async ReleaseCommit(): Promise<string | undefined>
    {
        return undefined
    }
}

class RecordingHelm implements IHelm
{
    public static readonly PushedDigest = 'sha256:' + 'c'.repeat(64)
    public readonly Packaged: Array<{ chartDir: string; version: string }> = []
    public readonly Pushed: string[] = []

    public Package(chartDir: string, version: string, outDir: string): string
    {
        this.Packaged.push({ chartDir, version })
        return join(outDir, 'pragmatic-engine-' + version + '.tgz')
    }

    public Push(packageFile: string, ociBase: string): string
    {
        this.Pushed.push(packageFile + ' -> ' + ociBase)
        return RecordingHelm.PushedDigest
    }
}

class BuildFixture
{
    public static Manifest(): ReleaseManifestDocument
    {
        const components: Record<string, unknown> = {}
        for (const app of ReleaseApps.All)
        {
            components[app] = { repository: 'pragmatic-tech-ai/' + app, version: '0.1.0', digest: 'sha256:' + createHash('sha256').update(app).digest('hex') }
        }
        return ReleaseManifest.Parse(JSON.stringify({ schema: 1, version: '0.1.0-early.16', components }))
    }

    public static async InTemp(body: (dir: string) => Promise<void>): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), 'chart-build-'))
        try
        {
            await body(dir)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

describe('ChartBuild', () =>
{
    it('ChartBuild fills every image digest from the manifest, bakes the descriptors, packages and pushes', async () =>
    {
        await BuildFixture.InTemp(async out =>
        {
            const helm = new RecordingHelm()
            const manifest = BuildFixture.Manifest()
            const result = await new ChartBuild(new FixtureAssets(), helm).Run(manifest, out, 'ghcr.io/pragmatic-tech-ai/charts')
            assert.deepEqual(result, { Version: '0.1.0-early.16', Digest: RecordingHelm.PushedDigest, Package: join(out, 'pragmatic-engine-0.1.0-early.16.tgz') })
            const staged = join(out, 'pragmatic-engine')
            const images = JSON.parse(readFileSync(join(staged, 'files', 'images.json'), 'utf8'))
            for (const app of ChartBuild.ChartApps)
            {
                assert.deepEqual(images[app], { repository: manifest.components[app].repository, digest: manifest.components[app].digest }, app)
                assert.ok(existsSync(join(staged, 'files', 'descriptors', app + '.json')), app)
            }
            const digests = JSON.parse(readFileSync(join(staged, 'files', 'descriptors', 'digests.json'), 'utf8'))
            const asset = readFileSync(join(staged, 'files', 'descriptors', 'pragmatic-tenant-admin.json'))
            assert.equal(digests['pragmatic-tenant-admin'], 'sha256:' + createHash('sha256').update(asset).digest('hex'))
            assert.deepEqual(helm.Pushed, [result.Package + ' -> ghcr.io/pragmatic-tech-ai/charts'])
            assert.deepEqual(helm.Packaged, [{ chartDir: staged, version: '0.1.0-early.16' }])
        })
    })

    it('leaves the host agent out of the chart images and descriptors', async () =>
    {
        await BuildFixture.InTemp(async out =>
        {
            await new ChartBuild(new FixtureAssets(), new RecordingHelm()).Run(BuildFixture.Manifest(), out)
            const staged = join(out, 'pragmatic-engine')
            const images = JSON.parse(readFileSync(join(staged, 'files', 'images.json'), 'utf8'))
            assert.deepEqual(Object.keys(images).sort(), [...ReleaseApps.Schema2Apps].sort())
            assert.equal(images[ReleaseApp.HostAgent], undefined)
            assert.equal(existsSync(join(staged, 'files', 'descriptors', ReleaseApp.HostAgent + '.json')), false)
            const digests = JSON.parse(readFileSync(join(staged, 'files', 'descriptors', 'digests.json'), 'utf8'))
            assert.equal(digests[ReleaseApp.HostAgent], undefined)
        })
    })

    it('refuses a manifest missing an app, and an app without its descriptor, packaging nothing', async () =>
    {
        await BuildFixture.InTemp(async out =>
        {
            const helm = new RecordingHelm()
            const manifest = BuildFixture.Manifest()
            const partial = { ...manifest, components: { ...manifest.components } } as Record<string, any>
            delete partial.components[ReleaseApp.TenantIdp]
            await assert.rejects(new ChartBuild(new FixtureAssets(), helm).Run(partial as ReleaseManifestDocument, out), (err: unknown) =>
                err instanceof ChartBuildError && err.message.includes('pragmatic-tenant-idp'))
            await assert.rejects(new ChartBuild(new FixtureAssets(ReleaseApp.Postgres), helm).Run(manifest, out), /no component descriptor asset for pragmatic-postgres/)
            assert.deepEqual(helm.Packaged, [])
        })
    })

    it('refuses to push the chart of a release already published', async () =>
    {
        await BuildFixture.InTemp(async out =>
        {
            const helm = new RecordingHelm()
            const published = { IsPublished: async (version: string) => version === '0.1.0-early.16' }
            await assert.rejects(new ChartBuild(new FixtureAssets(), helm, ChartBuild.DefaultChartDir, published).Run(BuildFixture.Manifest(), out, 'ghcr.io/pragmatic-tech-ai/charts'), /already published/)
            assert.deepEqual(helm.Packaged, [])
            assert.deepEqual(helm.Pushed, [])
            const notYet = { IsPublished: async () => false }
            await new ChartBuild(new FixtureAssets(), helm, ChartBuild.DefaultChartDir, notYet).Run(BuildFixture.Manifest(), out, 'ghcr.io/pragmatic-tech-ai/charts')
            assert.equal(helm.Pushed.length, 1, 'a stopped run before the descriptor is re-run as is')
        })
    })

    it('the CLI prints the version, the package and the pushed digest, and refuses bad arguments', async () =>
    {
        await BuildFixture.InTemp(async out =>
        {
            const lines: string[] = []
            const errors: string[] = []
            const output = { Out: (l: string) => lines.push(l), Err: (l: string) => errors.push(l) }
            assert.equal(await ChartBuildCli.Run(['--out', out], {}, output), 2)
            const manifestFile = join(out, 'release.json')
            const { writeFileSync } = await import('node:fs')
            writeFileSync(manifestFile, JSON.stringify(BuildFixture.Manifest()))
            assert.equal(await ChartBuildCli.Run(['--manifest', manifestFile, '--out', out, '--push'], {}, output, new FixtureAssets(), new RecordingHelm(), { IsPublished: async () => false }), 0)
            assert.deepEqual(lines.filter(l => !l.startsWith('package=')), ['version=0.1.0-early.16', 'digest=' + RecordingHelm.PushedDigest])
        })
    })
})
