import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseAllDocuments } from 'yaml'
import { ChartFixture, type K8sDoc } from './chart-fixture.js'

/** The Secrets the console's bootstrap mints (pragmatic-tenant-admin EngineSecretSet), by namespace scope. */
class MintedSecrets
{
    public static readonly Engine: readonly string[] = [
        'pragmatic-postgres-superuser', 'pragmatic-postgres-app-tenant-admin', 'pragmatic-postgres-app-tenant-idp',
        'pragmatic-tenant-admin-master-key', 'pragmatic-tenant-admin-fingerprint', 'pragmatic-tenant-admin-seed',
        'pragmatic-tenant-idp-admin-token', 'pragmatic-owner-initial', 'pragmatic-tenant-idp-ca', 'pragmatic-console-tls',
        'pragmatic-realm-master-key', 'pragmatic-postgres-realm-secrets-console', 'pragmatic-postgres-realm-secrets-idp', 'pragmatic-postgres-realm-secrets-environments',
    ]
    public static readonly Idp: readonly string[] = [
        'pragmatic-tenant-idp-master-key', 'pragmatic-tenant-idp-signing-key', 'pragmatic-tenant-idp-tls',
        'pragmatic-tenant-idp-admin-token', 'pragmatic-tenant-idp-database', 'pragmatic-realm-master-key', 'pragmatic-tenant-idp-realm-secrets',
    ]
    /** The configuration stores the bootstrap creates when absent; the pods mount them optionally. */
    public static readonly Optional: readonly string[] = ['pragmatic-secrets-pragmatic-tenant-admin', 'pragmatic-secrets-pragmatic-hive-agent', 'pragmatic-secrets-pragmatic-tenant-idp']
}

/**
 * The agent admission policy's expressions read the way the API server reads them, for the parts a template test can
 * evaluate: the image pattern (a CEL raw string, RE2; the pattern uses no feature where RE2 and JavaScript differ), the
 * namespace list and prefix, and the managed-by values. The full policy is proved live (C3.4 Task 8, kubectl --as).
 */
class AgentPolicyExpressions
{
    private static readonly ImagePattern = /matches\(r'([^']+)'\)/
    private static readonly NamespaceList = /variables\.namespace in \[([^\]]+)\]/
    private static readonly NamespacePrefix = /variables\.namespace\.startsWith\('([^']+)'\)/
    private static readonly ManagedList = /\['app\.kubernetes\.io\/managed-by'\] in \[([^\]]+)\]/
    private readonly text: string

    public constructor(validations: Array<{ expression: string }>)
    {
        this.text = validations.map(v => v.expression).join('\n')
    }

    public ImageAllowed(image: string): boolean
    {
        return new RegExp(AgentPolicyExpressions.ImagePattern.exec(this.text)![1]!).test(image)
    }

    public NamespaceAllowed(namespace: string): boolean
    {
        const listed = AgentPolicyExpressions.Quoted(AgentPolicyExpressions.NamespaceList.exec(this.text)![1]!)
        return listed.includes(namespace) || namespace.startsWith(AgentPolicyExpressions.NamespacePrefix.exec(this.text)![1]!)
    }

    public ManagedBy(): string[]
    {
        return AgentPolicyExpressions.Quoted(AgentPolicyExpressions.ManagedList.exec(this.text)![1]!)
    }

    private static Quoted(list: string): string[]
    {
        return list.split(',').map(entry => entry.trim().replace(/^'|'$/g, ''))
    }
}

class RenderFixture
{
    public static readonly Connected = { 'tls.mode': 'self-signed' }
    public static readonly Standalone = { 'tls.mode': 'self-signed', level: 'standalone' }
    public static readonly Hosted = { 'tls.mode': 'self-signed', hosted: 'true', 'console.host': 'acme-k3xq.hives.pragmatic-tech.ai', 'console.baseDomain': 'acme-k3xq.hives.pragmatic-tech.ai', 'console.address': 'relayed-hive-subdomain' }
    public static readonly HookAnnotation = 'helm.sh/hook'

    public static Workloads(docs: readonly K8sDoc[]): string[]
    {
        return docs.filter(d => ['Deployment', 'StatefulSet'].includes(d.kind)).map(d => d.kind + '/' + d.metadata.name).sort()
    }

    public static Jobs(docs: readonly K8sDoc[]): string[]
    {
        return docs.filter(d => d.kind === 'Job').map(d => d.metadata.name + ':' + d.metadata.annotations?.[RenderFixture.HookAnnotation] + ':' + d.metadata.annotations?.['helm.sh/hook-weight']).sort()
    }

    /** Every Secret a pod mounts, by the namespace the pod runs in. */
    public static MountedSecrets(docs: readonly K8sDoc[]): Array<{ namespace: string; name: string; optional: boolean }>
    {
        return docs.filter(d => ['Deployment', 'StatefulSet'].includes(d.kind)).flatMap(d => (d.spec.template.spec.volumes as any[]).flatMap(v =>
        {
            const sources = v.secret !== undefined ? [v.secret] : (v.projected?.sources ?? []).filter((s: any) => s.secret !== undefined).map((s: any) => ({ secretName: s.secret.name }))
            return sources.map((s: any) => ({ namespace: d.metadata.namespace as string, name: s.secretName as string, optional: s.optional === true }))
        }))
    }

    /** The rendered objects, parsed (comments and blank lines dropped). */
    public static Documents(text: string): unknown[]
    {
        return parseAllDocuments(text).map(d => d.toJS()).filter(d => d !== null && d !== undefined)
    }

    public static CheckGolden(name: string, text: string): void
    {
        const file = join(ChartFixture.Golden, name + '.yaml')
        if (process.env.UPDATE_GOLDEN === '1')
        {
            mkdirSync(ChartFixture.Golden, { recursive: true })
            writeFileSync(file, text)
            return
        }
        // Compared as documents, not bytes: helm releases differ in the blank lines a template's trimmed actions leave.
        assert.deepEqual(RenderFixture.Documents(text), RenderFixture.Documents(readFileSync(file, 'utf8')), name + ': the render changed; rerun with UPDATE_GOLDEN=1 and review the golden diff')
    }
}

describe('the pragmatic-engine chart', { skip: !ChartFixture.HasHelm() }, () =>
{
    it('renders the four workloads, two hook jobs and the configmaps for connected', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        assert.deepEqual(RenderFixture.Workloads(docs), [
            'Deployment/pragmatic-hive-acme-hive-agent', 'Deployment/pragmatic-idp-acme', 'Deployment/pragmatic-tenant-admin-acme', 'StatefulSet/pragmatic-postgres',
        ])
        assert.equal(RenderFixture.Jobs(docs).length, 3)
        for (const name of ['pragmatic-engine-descriptors', 'pragmatic-engine-release-keys', 'pragmatic-engine-release', 'pragmatic-postgres-applications'])
        {
            assert.ok(ChartFixture.Find(docs, 'ConfigMap', name), name)
        }
        const descriptors = ChartFixture.Find(docs, 'ConfigMap', 'pragmatic-engine-descriptors')!
        assert.ok('pragmatic-tenant-admin.json' in (descriptors.data ?? {}) && 'digests.json' in (descriptors.data ?? {}))
        assert.equal(ChartFixture.Find(docs, 'ConfigMap', 'pragmatic-postgres-applications')?.data?.['applications.conf'],
            'pragmatic-tenant-admin tenant_admin tenant_admin\npragmatic-tenant-idp tenant_idp tenant_idp\n')
        const idp = ChartFixture.Find(docs, 'Deployment', 'pragmatic-idp-acme')!
        assert.equal(idp.metadata.namespace, 'pragmatic-idp-acme')
        const env = Object.fromEntries((idp.spec.template.spec.containers[0].env as any[]).map(e => [e.name, e.value]))
        assert.equal(env.PRAGMATIC_IDP_BASE_URL, 'https://idp-acme.acme.example')
        assert.equal(env.PRAGMATIC_IDP_TRUSTED_PROXY, 'true')
        const console = ChartFixture.Find(docs, 'Deployment', 'pragmatic-tenant-admin-acme')!
        assert.equal(console.spec.strategy.type, 'Recreate', 'one pod on a ReadWriteOnce claim')
        const consoleEnv = Object.fromEntries((console.spec.template.spec.containers[0].env as any[]).map(e => [e.name, e.value]))
        assert.equal(consoleEnv.PRAGMATIC_ENGINE_MODE, 'connected')
        assert.equal(consoleEnv.PRAGMATIC_TENANT_ADMIN_TRUSTED_PROXY, 'true')
        assert.match(consoleEnv.PRAGMATIC_TENANT_ADMIN_ENV_SERVER_IMAGE, /^ghcr\.io\/pragmatic-tech-ai\/pragmatic-env-server@sha256:[0-9a-f]{64}$/)
    })

    it('mounts only the Secrets the bootstrap mints, in their namespaces', () =>
    {
        for (const values of [RenderFixture.Connected, RenderFixture.Standalone])
        {
            for (const mount of RenderFixture.MountedSecrets(ChartFixture.Render(values)))
            {
                const minted = mount.namespace === 'pragmatic-system' ? MintedSecrets.Engine : MintedSecrets.Idp
                assert.ok(minted.includes(mount.name) || (mount.optional && MintedSecrets.Optional.includes(mount.name)), mount.namespace + '/' + mount.name)
            }
        }
    })

    it('standalone renders no agent and contains no pragmatic-tech.ai host', () =>
    {
        const text = ChartFixture.Text(RenderFixture.Standalone)
        const docs = ChartFixture.Render(RenderFixture.Standalone)
        assert.deepEqual(RenderFixture.Workloads(docs), ['Deployment/pragmatic-idp-acme', 'Deployment/pragmatic-tenant-admin-acme', 'StatefulSet/pragmatic-postgres'])
        assert.equal(docs.some(d => d.metadata.name.includes('hive-agent') || d.metadata.name.includes('agent-placer')), false)
        assert.doesNotMatch(text, /https?:\/\/[^\s"']*pragmatic-tech\.ai/)
        assert.doesNotMatch(text, /\bagent\.pragmatic-tech\.ai\b/)
        const consoleEnv = (ChartFixture.Find(docs, 'Deployment', 'pragmatic-tenant-admin-acme')!.spec.template.spec.containers[0].env as any[])
        assert.equal(consoleEnv.find(e => e.name === 'PRAGMATIC_ENGINE_MODE')?.value, 'standalone')
        assert.equal(consoleEnv.some(e => e.name.startsWith('PRAGMATIC_TENANT_ADMIN_ROLLOUT')), false)
    })

    it('hosted binds the agent to cluster-admin, connected to the placer role', () =>
    {
        const hosted = ChartFixture.Render(RenderFixture.Hosted)
        assert.equal(ChartFixture.Find(hosted, 'ClusterRoleBinding', 'pragmatic-hive-acme-hive-agent')?.roleRef.name, 'cluster-admin')
        assert.equal(ChartFixture.Find(hosted, 'ClusterRole', 'pragmatic-hive-agent-placer'), undefined)
        const connected = ChartFixture.Render(RenderFixture.Connected)
        assert.equal(ChartFixture.Find(connected, 'ClusterRoleBinding', 'pragmatic-hive-acme-hive-agent')?.roleRef.name, 'pragmatic-hive-agent-placer')
        assert.ok(ChartFixture.Find(connected, 'ClusterRole', 'pragmatic-hive-agent-placer') !== undefined)
    })

    it('the placer role grants no read of secrets and no exec, port-forward, proxy or logs', () =>
    {
        const placer = ChartFixture.Find(ChartFixture.Render(RenderFixture.Connected), 'ClusterRole', 'pragmatic-hive-agent-placer')!
        const rules = placer.rules as Array<{ apiGroups: string[], resources: string[], verbs: string[] }>
        const granted = rules.flatMap(rule => rule.resources.map(resource => ({ resource, verbs: rule.verbs })))
        for (const forbidden of ['pods', 'pods/exec', 'pods/portforward', 'pods/log', 'pods/attach', 'services/proxy', 'nodes/proxy', 'nodes'])
        {
            assert.equal(granted.some(entry => entry.resource === forbidden), false, forbidden)
        }
        assert.ok(granted.every(entry => !entry.verbs.includes('*') && !entry.resource.includes('*')))
        const secrets = granted.filter(entry => entry.resource === 'secrets').flatMap(entry => entry.verbs)
        assert.deepEqual([...secrets].sort(), ['create', 'delete', 'patch'], 'Secrets placed, never read')
        const reads = granted.filter(entry => entry.verbs.some(verb => ['get', 'list', 'watch'].includes(verb))).map(entry => entry.resource).sort()
        assert.deepEqual(reads, ['deployments', 'namespaces', 'statefulsets'])
        for (const placed of ['deployments', 'statefulsets', 'services', 'configmaps', 'ingresses', 'networkpolicies', 'serviceaccounts', 'persistentvolumeclaims', 'namespaces'])
        {
            assert.ok(granted.some(entry => entry.resource === placed && ['create', 'update', 'patch', 'delete'].every(verb => entry.verbs.includes(verb))), placed)
        }
    })

    it('the admission policy is rendered unless hosted', () =>
    {
        const connected = ChartFixture.Render(RenderFixture.Connected)
        const policy = ChartFixture.Find(connected, 'ValidatingAdmissionPolicy', 'pragmatic-hive-acme-hive-agent')!
        assert.equal(policy.spec.failurePolicy, 'Fail')
        assert.deepEqual(policy.spec.matchConditions, [{ name: 'hive-agent-service-account', expression: "request.userInfo.username == 'system:serviceaccount:pragmatic-system:pragmatic-hive-acme-hive-agent'" }])
        const binding = ChartFixture.Find(connected, 'ValidatingAdmissionPolicyBinding', 'pragmatic-hive-acme-hive-agent')!
        assert.deepEqual(binding.spec, { policyName: 'pragmatic-hive-acme-hive-agent', validationActions: ['Deny'] })
        const placerResources = (ChartFixture.Find(connected, 'ClusterRole', 'pragmatic-hive-agent-placer')!.rules as any[]).flatMap(rule => rule.resources as string[])
        const fenced = (policy.spec.matchConstraints.resourceRules as any[]).flatMap(rule => rule.resources as string[])
        assert.ok(placerResources.every(resource => fenced.includes(resource)), 'every resource the agent may place is fenced')
        for (const values of [RenderFixture.Hosted, RenderFixture.Standalone])
        {
            const docs = ChartFixture.Render(values)
            assert.equal(docs.some(d => d.kind === 'ValidatingAdmissionPolicy' && d.metadata.name.includes('agent')), false)
            assert.equal(ChartFixture.Find(docs, 'ClusterRole', 'pragmatic-hive-agent-placer'), undefined)
        }
    })

    it('the policy\'s CEL expressions accept a managed digest image and reject a tag, another registry and another namespace', () =>
    {
        const policy = ChartFixture.Find(ChartFixture.Render(RenderFixture.Connected), 'ValidatingAdmissionPolicy', 'pragmatic-hive-acme-hive-agent')!
        const cel = new AgentPolicyExpressions(policy.spec.validations as Array<{ expression: string }>)
        const digest = '@sha256:' + 'a'.repeat(64)
        assert.ok(cel.ImageAllowed('ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin' + digest))
        assert.ok(cel.ImageAllowed('registry.pragmatic-tech.ai/pragmatic-tech-ai/pragmatic-postgres' + digest))
        assert.equal(cel.ImageAllowed('ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin:0.1.13'), false, 'a tag')
        assert.equal(cel.ImageAllowed('docker.io/pragmatic-tech-ai/pragmatic-tenant-admin' + digest), false, 'another registry')
        assert.equal(cel.ImageAllowed('ghcr.io/someone-else/pragmatic-tenant-admin' + digest), false, 'another organisation')
        assert.equal(cel.ImageAllowed('ghcr.io/pragmatic-tech-ai/x:1@sha256:' + 'a'.repeat(63)), false, 'a short digest')
        assert.ok(cel.NamespaceAllowed('pragmatic-system'))
        assert.ok(cel.NamespaceAllowed('pragmatic-idp-acme'))
        assert.ok(cel.NamespaceAllowed('pragmatic-env-prod'))
        assert.equal(cel.NamespaceAllowed('kube-system'), false)
        assert.equal(cel.NamespaceAllowed('default'), false)
        assert.deepEqual(cel.ManagedBy(), ['pragmatic-hive-agent', 'pragmatic-tenant-admin', 'pragmatic-engine'])
        // The engine's own workloads carry a managed-by the policy admits, so the agent can move them.
        const docs = ChartFixture.Render(RenderFixture.Connected)
        for (const workload of docs.filter(d => ['Deployment', 'StatefulSet'].includes(d.kind)))
        {
            assert.ok(cel.ManagedBy().includes(workload.metadata.labels?.['app.kubernetes.io/managed-by'] ?? ''), workload.kind + '/' + workload.metadata.name)
            for (const container of [...workload.spec.template.spec.containers, ...(workload.spec.template.spec.initContainers ?? [])])
            {
                assert.ok(cel.ImageAllowed(container.image), container.image)
            }
        }
    })

    it('the console\'s internal intent endpoint is reached by the agent only, with a token for audience pragmatic-tenant-admin', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const service = ChartFixture.Find(docs, 'Service', 'pragmatic-tenant-admin-acme-internal')!
        assert.deepEqual(service.spec.selector, { 'pragmatic/app': 'pragmatic-tenant-admin-acme' })
        assert.deepEqual(service.spec.ports, [{ name: 'intents', port: 7211, targetPort: 'intents' }])
        const consolePolicy = ChartFixture.Find(docs, 'NetworkPolicy', 'pragmatic-tenant-admin-acme')!
        assert.deepEqual((consolePolicy.spec.ingress as any[]).find(rule => rule.ports[0].port === 7211), { from: [{ podSelector: { matchLabels: { 'pragmatic/app': 'pragmatic-hive-acme-hive-agent' } } }], ports: [{ protocol: 'TCP', port: 7211 }] })
        const consolePod = ChartFixture.Find(docs, 'Deployment', 'pragmatic-tenant-admin-acme')!.spec.template.spec
        assert.ok((consolePod.containers[0].ports as any[]).some(port => port.name === 'intents' && port.containerPort === 7211))
        const consoleEnv = new Map((consolePod.containers[0].env as any[]).map(e => [e.name, e.value]))
        assert.equal(consoleEnv.get('PRAGMATIC_ENGINE_AGENT_SERVICE_ACCOUNT'), 'system:serviceaccount:pragmatic-system:pragmatic-hive-acme-hive-agent')
        const consoleRole = ChartFixture.Find(docs, 'ClusterRole', 'pragmatic-tenant-admin-acme')!
        assert.ok((consoleRole.rules as any[]).some(rule => rule.resources.includes('tokenreviews') && JSON.stringify(rule.verbs) === JSON.stringify(['create'])))
        const agentPod = ChartFixture.Find(docs, 'Deployment', 'pragmatic-hive-acme-hive-agent')!.spec.template.spec
        const volume = (agentPod.volumes as any[]).find(v => v.name === 'console-token')
        assert.deepEqual(volume.projected.sources, [{ serviceAccountToken: { audience: 'pragmatic-tenant-admin', expirationSeconds: 3600, path: 'token' } }])
        const mount = (agentPod.containers[0].volumeMounts as any[]).find(m => m.name === 'console-token')
        const agentEnv = new Map((agentPod.containers[0].env as any[]).map(e => [e.name, e.value]))
        assert.equal(agentEnv.get('PRAGMATIC_AGENT_CONSOLE_TOKEN_FILE'), mount.mountPath + '/token')
        assert.equal(agentEnv.get('PRAGMATIC_AGENT_CONSOLE_INTENT_URL'), 'http://pragmatic-tenant-admin-acme-internal.pragmatic-system.svc:7211')
        assert.equal(agentEnv.get('PRAGMATIC_AGENT_DEPLOYMENT'), 'pragmatic-hive-acme-hive-agent')
        const hosted = ChartFixture.Render(RenderFixture.Hosted)
        assert.equal(ChartFixture.Find(hosted, 'Service', 'pragmatic-tenant-admin-acme-internal'), undefined)
        const hostedAgent = ChartFixture.Find(hosted, 'Deployment', 'pragmatic-hive-acme-hive-agent')!.spec.template.spec
        assert.equal((hostedAgent.volumes as any[]).some(v => v.name === 'console-token'), false)
        assert.equal((hostedAgent.containers[0].env as any[]).some(e => e.name === 'PRAGMATIC_AGENT_CONSOLE_INTENT_URL'), false)
    })

    it('every image is referenced by digest', () =>
    {
        for (const values of [RenderFixture.Connected, RenderFixture.Standalone])
        {
            const docs = ChartFixture.Render(values)
            for (const pod of ChartFixture.Pods(docs))
            {
                for (const container of [...(pod.spec.initContainers ?? []), ...pod.spec.containers])
                {
                    assert.match(container.image, /^ghcr\.io\/pragmatic-tech-ai\/pragmatic-[a-z-]+@sha256:[0-9a-f]{64}$/, pod.owner + '/' + container.name)
                }
            }
        }
        const mirrored = ChartFixture.Render({ ...RenderFixture.Connected, 'images.registry': 'mirror.example.com:5000' })
        assert.ok(ChartFixture.Pods(mirrored).every(p => p.spec.containers.every((c: any) => c.image.startsWith('mirror.example.com:5000/pragmatic-tech-ai/'))))
    })

    it('the schema refuses a missing tenant.id or console.host and any secrets.* value', () =>
    {
        assert.match(ChartFixture.Refusal({ 'tenant.id': '' }), /tenant\.id|tenant\/id|id/)
        assert.match(ChartFixture.Refusal({ 'console.host': '' }), /host/)
        assert.match(ChartFixture.Refusal({ 'secrets.ownerPassword': 'x' }), /secrets/)
        assert.match(ChartFixture.Refusal({ 'tenant.id': 'Not_Valid' }), /tenant/)
        assert.match(ChartFixture.Refusal({ level: 'enrolled' }), /level/)
    })

    it('refuses another namespace and a secret TLS mode without its Secret', () =>
    {
        assert.match(ChartFixture.Refusal(RenderFixture.Connected, 'default'), /namespace pragmatic-system/)
        assert.match(ChartFixture.Refusal({}), /tls\.secretName/)
        const own = ChartFixture.Render({ 'tls.secretName': 'acme-tls' })
        assert.equal(ChartFixture.Find(own, 'Ingress', 'pragmatic-tenant-admin-acme')?.spec.tls[0].secretName, 'acme-tls')
    })

    it('postgres PVC and every minted secret carry helm.sh/resource-policy keep', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const claims = docs.filter(d => d.kind === 'PersistentVolumeClaim')
        assert.deepEqual(claims.map(c => c.metadata.name).sort(), ['pragmatic-postgres-data', 'pragmatic-tenant-admin-acme-data'])
        for (const claim of claims)
        {
            assert.equal(claim.metadata.annotations?.['helm.sh/resource-policy'], 'keep', claim.metadata.name)
        }
        // The chart renders no Secret at all: every engine Secret is the bootstrap's (minted with keep, never chart-owned).
        assert.equal(docs.some(d => d.kind === 'Secret'), false)
    })

    it('every pod is non-root, read-only root, RuntimeDefault seccomp, with limits', () =>
    {
        for (const values of [RenderFixture.Connected, RenderFixture.Hosted])
        {
            for (const pod of ChartFixture.Pods(ChartFixture.Render(values)))
            {
                assert.equal(pod.spec.securityContext.runAsNonRoot, true, pod.owner)
                assert.equal(pod.spec.securityContext.seccompProfile.type, 'RuntimeDefault', pod.owner)
                for (const container of [...(pod.spec.initContainers ?? []), ...pod.spec.containers])
                {
                    const at = pod.owner + '/' + container.name
                    const security = container.securityContext
                    assert.equal(security.runAsNonRoot, true, at)
                    assert.equal(security.readOnlyRootFilesystem, true, at)
                    assert.equal(security.allowPrivilegeEscalation, false, at)
                    assert.deepEqual(security.capabilities.drop, ['ALL'], at)
                    assert.equal(security.seccompProfile.type, 'RuntimeDefault', at)
                    assert.ok(container.resources?.limits?.cpu && container.resources?.limits?.memory, at)
                    assert.ok(container.resources?.requests?.cpu && container.resources?.requests?.memory, at)
                }
            }
        }
    })

    it('no value can change a release image: the schema refuses images.apps, a mirror may only replace the registry', () =>
    {
        assert.match(ChartFixture.Refusal({ ...RenderFixture.Connected, 'images.apps.pragmatic-postgres.digest': 'sha256:' + '0'.repeat(64) }), /images/)
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const allowList = JSON.parse(ChartFixture.Find(docs, 'ConfigMap', 'pragmatic-engine-release')!.data!['verified-images.json']) as Array<{ imageRef: string }>
        assert.deepEqual(allowList.map(i => i.imageRef.split('@')[0]), ['ghcr.io/pragmatic-tech-ai/pragmatic-env-server', 'ghcr.io/pragmatic-tech-ai/pragmatic-ui-unpack'], 'environments may run only these')
    })

    it('the bootstrap reads and writes Secrets only by name in the engine\'s two namespaces, and every hook account goes with its hooks', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const hooks = docs.filter(d => d.metadata.annotations?.['helm.sh/hook'] !== undefined)
        for (const role of hooks.filter(d => d.kind === 'ClusterRole'))
        {
            const resources = (role.rules ?? []).flatMap((r: any) => r.resources ?? [])
            assert.equal(resources.includes('secrets'), false, role.metadata.name + ' grants no Secret access cluster-wide')
        }
        const roles = hooks.filter(d => d.kind === 'Role' && d.metadata.name === 'pragmatic-engine-bootstrap')
        assert.deepEqual(roles.map(r => r.metadata.namespace).sort(), ['pragmatic-idp-acme', 'pragmatic-system'])
        for (const role of roles)
        {
            const read = (role.rules ?? []).find((r: any) => (r.verbs as string[]).includes('get'))
            assert.ok(Array.isArray(read.resourceNames) && read.resourceNames.length > 0, 'reads only named Secrets')
        }
        for (const object of hooks.filter(d => d.kind !== 'Job'))
        {
            assert.match(object.metadata.annotations!['helm.sh/hook-delete-policy'], /hook-failed/, object.kind + '/' + object.metadata.name)
        }
        const preflight = hooks.find(d => d.kind === 'Role' && d.metadata.name === 'pragmatic-engine-preflight')!
        assert.deepEqual(preflight.rules![0].resourceNames, ['pragmatic-tenant-admin-seed'], 'self-signed: the preflight reads only the kept seed (its ids)')
        assert.deepEqual(RenderFixture.Jobs(docs), [
            'pragmatic-engine-bootstrap:pre-install,pre-upgrade:-10', 'pragmatic-engine-namespace:pre-install,pre-upgrade:-18', 'pragmatic-engine-preflight:pre-install,pre-upgrade:-20',
        ])
    })

    it('only the ingress controller, the console and this hive\'s environments reach the sign-in service and Postgres', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const idp = ChartFixture.Find(docs, 'NetworkPolicy', 'pragmatic-idp-acme')!
        assert.equal(idp.metadata.namespace, 'pragmatic-idp-acme')
        assert.deepEqual(idp.spec.ingress[0].ports, [{ protocol: 'TCP', port: 9443 }])
        assert.equal(idp.spec.ingress[0].from.length, 3)
        assert.ok(ChartFixture.Find(docs, 'NetworkPolicy', 'pragmatic-postgres'))
        // The console and the environments reach Postgres at EnvironmentHiveDatabase.ServiceHost (pragmatic-tenant-plane).
        const service = ChartFixture.Find(docs, 'Service', 'pragmatic-postgres')!
        assert.equal(service.metadata.name + '.' + service.metadata.namespace + '.svc', 'pragmatic-postgres.pragmatic-system.svc')
    })

    it('a standalone console configures no agent; the console Ingress allows long API calls', () =>
    {
        const standalone = ChartFixture.Render(RenderFixture.Standalone)
        const role = standalone.find(d => d.kind === 'Role' && d.metadata.name === 'pragmatic-tenant-admin-acme-configuration' && d.metadata.namespace === 'pragmatic-system')!
        assert.equal(JSON.stringify(role.rules).includes('hive-agent'), false)
        assert.equal(ChartFixture.Find(standalone, 'Ingress', 'pragmatic-tenant-admin-acme')?.metadata.annotations?.['nginx.ingress.kubernetes.io/proxy-read-timeout'], '180')
        const env = (ChartFixture.Find(standalone, 'Deployment', 'pragmatic-tenant-admin-acme')!.spec.template.spec.containers[0].env as any[])
        assert.equal(env.find(e => e.name === 'PRAGMATIC_TENANT_ADMIN_RELEASE_KEYS_DIR')?.value, '/etc/pragmatic/release-keys')
        assert.ok('release-2026-11.pub.pem' in (ChartFixture.Find(standalone, 'ConfigMap', 'pragmatic-engine-release-keys')?.data ?? {}))
    })

    it('the agent may read only its own identity secret', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const agent = 'pragmatic-hive-acme-hive-agent'
        const bound = docs.filter(d => ['RoleBinding', 'ClusterRoleBinding'].includes(d.kind) && (d.subjects as any[]).some(subject => subject.kind === 'ServiceAccount' && subject.name === agent))
        const roles = bound.map(binding => docs.find(d => d.kind === binding.roleRef.kind && d.metadata.name === binding.roleRef.name && (binding.kind === 'ClusterRoleBinding' || d.metadata.namespace === binding.metadata.namespace))!)
        assert.ok(roles.every(role => role !== undefined), 'every binding names a rendered role')
        const secretRules = roles.flatMap(role => (role.rules as any[]).filter(rule => (rule.resources as string[]).includes('secrets')).map(rule => ({ kind: role.kind, rule })))
        assert.ok(secretRules.length > 0)
        for (const { kind, rule } of secretRules)
        {
            if (kind === 'ClusterRole')
            {
                // The placer: Secrets placed cluster-wide (fenced by the admission policy), never read.
                assert.deepEqual([...rule.verbs].sort(), ['create', 'delete', 'patch'], 'no cluster-wide Secret read')
                continue
            }
            const reads = (rule.verbs as string[]).filter(verb => verb !== 'create')
            if (reads.length > 0)
            {
                assert.deepEqual(rule.resourceNames, ['pragmatic-hive-identity'])
                assert.deepEqual(reads.sort(), ['get', 'update'])
            }
        }
        const configMaps = roles.flatMap(role => (role.rules as any[]).filter(rule => (rule.resources as string[]).includes('configmaps')))
        assert.ok(configMaps.every(rule => (rule.verbs as string[]).every(verb => verb !== 'get' && verb !== 'list' && verb !== 'watch') || JSON.stringify(rule.resourceNames) === JSON.stringify(['pragmatic-hive-enrolment', 'pragmatic-hive-intents'])))
        const reporter = ChartFixture.Find(docs, 'ClusterRole', 'pragmatic-hive-agent-reporter')!
        assert.deepEqual(reporter.rules, [
            { apiGroups: ['authentication.k8s.io'], resources: ['tokenreviews'], verbs: ['create'] },
            { apiGroups: ['apps'], resources: ['deployments'], verbs: ['list'] },
        ])
    })

    it('only the console reaches the agent\'s internal port', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const policy = ChartFixture.Find(docs, 'NetworkPolicy', 'pragmatic-hive-acme-hive-agent')!
        assert.deepEqual(policy.spec.podSelector.matchLabels, { 'pragmatic/app': 'pragmatic-hive-acme-hive-agent' })
        assert.deepEqual(policy.spec.ingress, [{ from: [{ podSelector: { matchLabels: { 'app.kubernetes.io/component': 'pragmatic-tenant-admin' } } }], ports: [{ protocol: 'TCP', port: 7210 }] }])
        const consolePod = ChartFixture.Find(docs, 'Deployment', 'pragmatic-tenant-admin-acme')!.spec.template.metadata.labels
        assert.equal(consolePod['app.kubernetes.io/component'], 'pragmatic-tenant-admin', 'the console\'s pods carry the label the policy admits')
        const agentPod = ChartFixture.Find(docs, 'Deployment', 'pragmatic-hive-acme-hive-agent')!.spec.template.metadata.labels
        assert.notEqual(agentPod['app.kubernetes.io/component'], 'pragmatic-tenant-admin')
        const service = ChartFixture.Find(docs, 'Service', 'pragmatic-hive-agent-internal')!
        assert.deepEqual(service.spec.selector, { 'pragmatic/app': 'pragmatic-hive-acme-hive-agent' })
        assert.deepEqual(service.spec.ports, [{ name: 'internal', port: 7210, targetPort: 'internal' }])
        const standalone = ChartFixture.Render(RenderFixture.Standalone)
        assert.equal(ChartFixture.Find(standalone, 'Service', 'pragmatic-hive-agent-internal'), undefined)
    })

    it('the console mounts a token for audience pragmatic-hive-agent', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const pod = ChartFixture.Find(docs, 'Deployment', 'pragmatic-tenant-admin-acme')!.spec.template.spec
        const volume = (pod.volumes as any[]).find(v => v.name === 'hive-agent-token')
        assert.deepEqual(volume.projected.sources, [{ serviceAccountToken: { audience: 'pragmatic-hive-agent', expirationSeconds: 3600, path: 'token' } }])
        const container = pod.containers[0]
        const mount = (container.volumeMounts as any[]).find(m => m.name === 'hive-agent-token')
        const env = new Map((container.env as any[]).map(e => [e.name, e.value]))
        assert.equal(env.get('PRAGMATIC_TENANT_ADMIN_AGENT_TOKEN_FILE'), mount.mountPath + '/token')
        assert.equal(env.get('PRAGMATIC_TENANT_ADMIN_AGENT_URL'), 'http://pragmatic-hive-agent-internal.pragmatic-system.svc:7210')
        assert.equal(env.get('PRAGMATIC_TENANT_ADMIN_CONSOLE_ADDRESS'), 'own-domain')
        const agentEnv = new Map((ChartFixture.Find(docs, 'Deployment', 'pragmatic-hive-acme-hive-agent')!.spec.template.spec.containers[0].env as any[]).map(e => [e.name, e.value]))
        assert.equal(agentEnv.get('PRAGMATIC_AGENT_CONSOLE_SERVICE_ACCOUNT'), pod.serviceAccountName, 'the agent admits exactly the console\'s account')
        assert.equal(agentEnv.get('PRAGMATIC_AGENT_TENANT'), 'acme')
        assert.match(String(ChartFixture.Find(docs, 'ConfigMap', 'pragmatic-hive-agent-trust-root')?.data?.['platform.pub.pem']), /^-----BEGIN PUBLIC KEY-----/)
        const standalonePod = ChartFixture.Find(ChartFixture.Render(RenderFixture.Standalone), 'Deployment', 'pragmatic-tenant-admin-acme')!.spec.template.spec
        assert.equal((standalonePod.volumes as any[]).some(v => v.name === 'hive-agent-token'), false)
    })

    it('a hosted hive enrols itself with the host agent code: connected settings, the relayed console, no enrolment API, no token', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Hosted)
        const agent = ChartFixture.Find(docs, 'Deployment', 'pragmatic-hive-acme-hive-agent')!.spec.template.spec
        const env = new Map((agent.containers[0].env as any[]).map(e => [e.name, e.value]))
        assert.equal(env.get('PRAGMATIC_AGENT_TRUST_ROOT_FILE'), '/etc/pragmatic/agent-trust-root/platform.pub.pem')
        assert.equal(env.get('PRAGMATIC_AGENT_TENANT'), 'acme')
        assert.equal(env.get('PRAGMATIC_AGENT_HOSTED'), 'true')
        assert.equal(env.get('PRAGMATIC_AGENT_CONSOLE_HOST'), 'acme-k3xq.hives.pragmatic-tech.ai')
        assert.equal(env.get('PRAGMATIC_AGENT_CONSOLE_ADDRESS'), 'relayed-hive-subdomain')
        assert.equal(env.has('PRAGMATIC_AGENT_TOKEN_FILE'), false)
        assert.equal(agent.containers[0].ports, undefined, 'no internal API port')
        assert.equal((agent.volumes as any[]).some(v => v.name === 'agent-token'), false)
        assert.match(String(ChartFixture.Find(docs, 'ConfigMap', 'pragmatic-hive-agent-trust-root')?.data?.['platform.pub.pem']), /^-----BEGIN PUBLIC KEY-----/)
        assert.equal(ChartFixture.Find(docs, 'Service', 'pragmatic-hive-agent-internal'), undefined)
        assert.equal(ChartFixture.Find(docs, 'NetworkPolicy', 'pragmatic-hive-agent-internal'), undefined)
        assert.equal(ChartFixture.Find(docs, 'ClusterRole', 'pragmatic-hive-agent-reporter'), undefined)
        const connectedAgent = ChartFixture.Find(ChartFixture.Render(RenderFixture.Connected), 'Deployment', 'pragmatic-hive-acme-hive-agent')!.spec.template.spec
        assert.equal((connectedAgent.containers[0].env as any[]).some(e => e.name === 'PRAGMATIC_AGENT_HOSTED'), false)
        const consoleEnv = (ChartFixture.Find(docs, 'Deployment', 'pragmatic-tenant-admin-acme')!.spec.template.spec.containers[0].env as any[]).map(e => e.name)
        assert.equal(consoleEnv.includes('PRAGMATIC_TENANT_ADMIN_AGENT_URL'), false)
    })

    it('a hosted engine publishes its sign-in service and environments under its own hive name, nothing shared', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Hosted)
        const hosts = docs.filter(d => d.kind === 'Ingress').flatMap(d => (d.spec.rules as any[]).map(rule => rule.host as string))
        assert.ok(hosts.length > 0)
        for (const host of hosts)
        {
            assert.ok(host === 'acme-k3xq.hives.pragmatic-tech.ai' || host.endsWith('.acme-k3xq.hives.pragmatic-tech.ai'), host)
        }
        const text = ChartFixture.Text(RenderFixture.Hosted)
        assert.match(text, /idp-acme\.acme-k3xq\.hives\.pragmatic-tech\.ai/)
        assert.match(ChartFixture.Refusal({ ...RenderFixture.Hosted, 'console.baseDomain': '' }), /console\.baseDomain must equal console\.host/)
    })

    it('hosted is refused unless connected with the relayed console address', () =>
    {
        assert.match(ChartFixture.Refusal({ ...RenderFixture.Hosted, 'console.address': 'own-domain' }), /\/console\/address': value must be 'relayed-hive-subdomain'/)
        assert.match(ChartFixture.Refusal({ ...RenderFixture.Hosted, level: 'standalone' }), /\/level': value must be 'connected'/)
    })

    it('helm lint passes on the chart as a release builds it', () =>
    {
        const lint = spawnSync('helm', ['lint', ChartFixture.Chart(), '--namespace', 'pragmatic-system', '--set', 'tenant.id=acme', '--set', 'console.host=console.acme.example', '--set', 'tls.mode=self-signed'], { encoding: 'utf8' })
        assert.equal(lint.status, 0, lint.stdout + lint.stderr)
    })

    it('goldens for the three modes', () =>
    {
        RenderFixture.CheckGolden('connected', ChartFixture.Text(RenderFixture.Connected))
        RenderFixture.CheckGolden('standalone', ChartFixture.Text(RenderFixture.Standalone))
        RenderFixture.CheckGolden('hosted', ChartFixture.Text(RenderFixture.Hosted))
    })
})
