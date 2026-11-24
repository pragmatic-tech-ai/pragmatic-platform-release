import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'
import { ReleaseManifest, type ReleaseManifestDocument } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ChartBuild } from '../../tools/chart-build.js'

export type K8sDoc = { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }; spec?: any; data?: Record<string, string>; rules?: any[]; roleRef?: any; subjects?: any[] }

/**
 * The chart as a release builds it (ChartBuild.FillDigests over the repository's release.json, fixture descriptors), staged
 * once per process, and `helm template` over it. Every test renders through the real helm CLI.
 */
export class ChartFixture
{
    public static readonly Root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    public static readonly Golden = join(ChartFixture.Root, 'tests', 'chart', 'golden')
    public static readonly Namespace = 'pragmatic-system'
    public static readonly Base: Record<string, string> = { 'tenant.id': 'acme', 'console.host': 'console.acme.example' }
    private static staged: string | undefined

    /** release.json with stable digests (the sha256 of each app's name), so the goldens do not move with every release. */
    public static Manifest(): ReleaseManifestDocument
    {
        const manifest = ReleaseManifest.Parse(readFileSync(join(ChartFixture.Root, 'release.json'), 'utf8'))
        const components = Object.fromEntries(Object.entries(manifest.components).map(([app, c]) =>
            [app, { ...c, digest: 'sha256:' + createHash('sha256').update(app).digest('hex') }]))
        return { ...manifest, version: '0.0.0-test', components } as ReleaseManifestDocument
    }

    /** The filled chart folder (digests from release.json, one small descriptor per app). */
    public static Chart(): string
    {
        if (ChartFixture.staged !== undefined)
        {
            return ChartFixture.staged
        }
        const dir = mkdtempSync(join(tmpdir(), 'pragmatic-engine-chart-'))
        const chart = join(dir, ChartBuild.ChartName)
        cpSync(ChartBuild.DefaultChartDir, chart, { recursive: true })
        ChartBuild.WriteImages(join(chart, ChartBuild.ImagesFile), ChartFixture.Manifest())
        const descriptors = join(chart, ChartBuild.DescriptorsDir)
        mkdirSync(descriptors, { recursive: true })
        for (const app of ChartBuild.ChartApps)
        {
            writeFileSync(join(descriptors, app + '.json'), JSON.stringify({ component: app, schema: 1 }))
        }
        writeFileSync(join(descriptors, ChartBuild.DigestsFile), '{}\n')
        process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
        ChartFixture.staged = chart
        return chart
    }

    public static Args(values: Record<string, string>, namespace: string = ChartFixture.Namespace): string[]
    {
        const args = ['template', 'pragmatic-engine', ChartFixture.Chart(), '--namespace', namespace]
        for (const [key, value] of Object.entries({ ...ChartFixture.Base, ...values }))
        {
            args.push('--set', key + '=' + value)
        }
        return args
    }

    /** The rendered manifest text (hooks included). */
    public static Text(values: Record<string, string> = {}): string
    {
        return execFileSync('helm', ChartFixture.Args(values), { encoding: 'utf8' })
    }

    public static Render(values: Record<string, string> = {}): K8sDoc[]
    {
        return parseAllDocuments(ChartFixture.Text(values)).map(d => d.toJS() as K8sDoc).filter(d => d !== null && d !== undefined)
    }

    /** A render helm refuses: its error text. */
    public static Refusal(values: Record<string, string>, namespace?: string): string
    {
        const result = spawnSync('helm', ChartFixture.Args(values, namespace), { encoding: 'utf8' })
        if (result.status === 0)
        {
            throw new Error('helm rendered what it should refuse')
        }
        return result.stderr
    }

    public static Find(docs: readonly K8sDoc[], kind: string, name: string): K8sDoc | undefined
    {
        return docs.find(d => d.kind === kind && d.metadata.name === name)
    }

    /** Every pod template of the render: Deployments, the StatefulSet and the Jobs. */
    public static Pods(docs: readonly K8sDoc[]): Array<{ owner: string; spec: any }>
    {
        return docs
            .filter(d => ['Deployment', 'StatefulSet', 'Job'].includes(d.kind))
            .map(d => ({ owner: d.kind + '/' + d.metadata.name, spec: d.spec.template.spec }))
    }

    public static HasHelm(): boolean
    {
        return spawnSync('helm', ['version'], { encoding: 'utf8' }).status === 0
    }
}
