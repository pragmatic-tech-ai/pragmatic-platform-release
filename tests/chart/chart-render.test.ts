import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseAllDocuments } from 'yaml'
import { evaluate } from '@marcbachmann/cel-js'
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

/** One admission request to the agent's policy: who, what, the object before and after. */
type AdmissionCase = { Operation: 'CREATE' | 'UPDATE' | 'DELETE', Group: string, Resource: string, Namespace: string, Object: any, OldObject: any, Username?: string }

/**
 * The hive agent's ValidatingAdmissionPolicy, evaluated as the API server evaluates it (cel-js: the CEL macros the policy
 * uses): the match conditions, then the variables in order, then every validation. The resource rules are assumed matched
 * (the cases name matched resources). The live dry-run is C3.4 Task 8's.
 */
class AgentPolicy
{
    public static readonly Agent = 'system:serviceaccount:pragmatic-system:pragmatic-hive-acme-hive-agent'

    public constructor(private readonly policy: K8sDoc)
    {
    }

    /** The messages of the validations that deny the case (empty: admitted); null when the policy does not match it. */
    public Denials(test: AdmissionCase): string[] | null
    {
        const request = {
            operation: test.Operation, namespace: test.Namespace, resource: { group: test.Group, version: 'v1', resource: test.Resource },
            userInfo: { username: test.Username ?? AgentPolicy.Agent },
        }
        const context: Record<string, unknown> = { request, object: test.Object, oldObject: test.OldObject, variables: {} }
        for (const condition of this.policy.spec.matchConditions as Array<{ expression: string }>)
        {
            if (evaluate(condition.expression, context) !== true)
            {
                return null
            }
        }
        const variables: Record<string, unknown> = {}
        for (const variable of this.policy.spec.variables as Array<{ name: string, expression: string }>)
        {
            variables[variable.name] = evaluate(variable.expression, { ...context, variables })
        }
        const denials: string[] = []
        for (const validation of this.policy.spec.validations as Array<{ expression: string, message: string }>)
        {
            let admitted: boolean
            try
            {
                admitted = evaluate(validation.expression, { ...context, variables }) === true
            }
            catch
            {
                // An expression that cannot be evaluated denies (failurePolicy Fail).
                admitted = false
            }
            if (!admitted)
            {
                denials.push(validation.message)
            }
        }
        return denials
    }

    /** A copy of a rendered object, changed by `change`. */
    public static Changed<T>(object: T, change: (copy: any) => void): T
    {
        const copy = JSON.parse(JSON.stringify(object)) as T
        change(copy)
        return copy
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
        assert.deepEqual(placer.rules, [
            { apiGroups: ['apps'], resources: ['deployments'], resourceNames: ['pragmatic-tenant-admin-acme', 'pragmatic-hive-acme-hive-agent', 'pragmatic-idp-acme'], verbs: ['get', 'patch', 'update'] },
            { apiGroups: ['apps'], resources: ['statefulsets'], resourceNames: ['pragmatic-postgres'], verbs: ['get', 'patch', 'update'] },
        ], 'only the engine\'s four workloads, by name: no Secrets or ConfigMaps (create-only stays on the namespaced Role), no list or watch, nothing on pods or proxies')
    })

    it('the admission policy is rendered unless hosted', () =>
    {
        const connected = ChartFixture.Render(RenderFixture.Connected)
        const policy = ChartFixture.Find(connected, 'ValidatingAdmissionPolicy', 'pragmatic-hive-acme-hive-agent')!
        assert.equal(policy.spec.failurePolicy, 'Fail')
        const binding = ChartFixture.Find(connected, 'ValidatingAdmissionPolicyBinding', 'pragmatic-hive-acme-hive-agent')!
        assert.deepEqual(binding.spec, { policyName: 'pragmatic-hive-acme-hive-agent', validationActions: ['Deny'] })
        const fenced = (policy.spec.matchConstraints.resourceRules as any[]).flatMap(rule => rule.resources as string[])
        for (const resource of ['namespaces', 'secrets', 'configmaps', 'deployments', 'statefulsets', 'leases', 'pods', 'jobs', 'rolebindings'])
        {
            assert.ok(fenced.includes(resource), resource)
        }
        for (const values of [RenderFixture.Hosted, RenderFixture.Standalone])
        {
            const docs = ChartFixture.Render(values)
            assert.equal(docs.some(d => d.kind === 'ValidatingAdmissionPolicy' && d.metadata.name.includes('agent')), false)
            assert.equal(ChartFixture.Find(docs, 'ClusterRole', 'pragmatic-hive-agent-placer'), undefined)
        }
    })

    it('the policy\'s CEL expressions accept a managed digest image and reject a tag, another registry and another namespace', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const policy = new AgentPolicy(ChartFixture.Find(docs, 'ValidatingAdmissionPolicy', 'pragmatic-hive-acme-hive-agent')!)
        const console = ChartFixture.Find(docs, 'Deployment', 'pragmatic-tenant-admin-acme')!
        const agent = ChartFixture.Find(docs, 'Deployment', 'pragmatic-hive-acme-hive-agent')!
        const postgres = ChartFixture.Find(docs, 'StatefulSet', 'pragmatic-postgres')!
        const digest = '@sha256:' + 'e'.repeat(64)
        const moved = (workload: K8sDoc, image: string): K8sDoc => AgentPolicy.Changed(workload, copy =>
        {
            for (const container of [...copy.spec.template.spec.containers, ...(copy.spec.template.spec.initContainers ?? [])])
            {
                container.image = image
            }
        })
        const update = (old: K8sDoc, next: K8sDoc, resource = 'deployments'): AdmissionCase => ({ Operation: 'UPDATE', Group: 'apps', Resource: resource, Namespace: 'pragmatic-system', Object: next, OldObject: old })

        // Admitted: an image-only move of each engine workload by digest, and a restart annotation.
        assert.deepEqual(policy.Denials(update(console, moved(console, 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin' + digest))), [])
        assert.deepEqual(policy.Denials(update(agent, moved(agent, 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent' + digest))), [])
        // The two release registries are one (C3.5 moves the images to registry.pragmatic-tech.ai): either way, the path is pinned.
        const moving = moved(agent, 'registry.pragmatic-tech.ai/pragmatic-tech-ai/pragmatic-hive-agent' + digest)
        assert.deepEqual(policy.Denials(update(agent, moving)), [], 'ghcr.io to registry.pragmatic-tech.ai')
        assert.deepEqual(policy.Denials(update(moving, moved(agent, 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent' + digest))), [], 'and back')
        assert.ok((policy.Denials(update(agent, moved(agent, 'quay.io/pragmatic-tech-ai/pragmatic-hive-agent' + digest))) ?? []).length > 0, 'a third host')
        assert.deepEqual(policy.Denials(update(postgres, moved(postgres, 'ghcr.io/pragmatic-tech-ai/pragmatic-postgres' + digest), 'statefulsets')), [])
        assert.deepEqual(policy.Denials(update(agent, AgentPolicy.Changed(agent, copy => { copy.spec.template.metadata.annotations = { 'kubectl.kubernetes.io/restartedAt': '2026-11-25T00:00:00Z' } }))), [])

        // Images: a tag (also in an init container), another registry, another organisation.
        const taggedInit = AgentPolicy.Changed(console, copy => { copy.spec.template.spec.initContainers[0].image = 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin:0.1.13' })
        assert.ok((policy.Denials(update(console, taggedInit)) ?? []).length > 0)
        assert.ok((policy.Denials(update(agent, moved(agent, 'docker.io/pragmatic-tech-ai/pragmatic-hive-agent' + digest))) ?? []).length > 0)
        assert.ok((policy.Denials(update(agent, moved(agent, 'ghcr.io/someone-else/pragmatic-hive-agent' + digest))) ?? []).length > 0)

        // "Look by placing": a shell command, an env from a Secret, another Secret mounted, another account, hostPath,
        // privileged, host network, added capabilities.
        const looks: Array<[string, (copy: any) => void]> = [
            ['command', copy => { copy.spec.template.spec.containers[0].command = ['sh', '-c', 'cat /run/secrets/*'] }],
            ['envFrom', copy => { copy.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: 'pragmatic-postgres-superuser' } }] }],
            ['env', copy => { copy.spec.template.spec.containers[0].env = [...(copy.spec.template.spec.containers[0].env ?? []), { name: 'X', valueFrom: { secretKeyRef: { name: 'pragmatic-owner-initial', key: 'password' } } }] }],
            ['volume', copy => { copy.spec.template.spec.volumes = [...(copy.spec.template.spec.volumes ?? []), { name: 'steal', secret: { secretName: 'pragmatic-postgres-superuser' } }] }],
            ['service account', copy => { copy.spec.template.spec.serviceAccountName = 'pragmatic-tenant-admin-acme' }],
            ['hostPath', copy => { copy.spec.template.spec.volumes = [...(copy.spec.template.spec.volumes ?? []), { name: 'host', hostPath: { path: '/' } }] }],
            ['privileged', copy => { copy.spec.template.spec.containers[0].securityContext = { privileged: true } }],
            ['hostNetwork', copy => { copy.spec.template.spec.hostNetwork = true }],
            ['capabilities', copy => { copy.spec.template.spec.containers[0].securityContext = { ...copy.spec.template.spec.containers[0].securityContext, capabilities: { add: ['SYS_ADMIN'] } } }],
            ['another container', copy => { copy.spec.template.spec.containers.push({ name: 'shell', image: copy.spec.template.spec.containers[0].image }) }],
        ]
        for (const [name, change] of looks)
        {
            assert.ok((policy.Denials(update(agent, AgentPolicy.Changed(agent, change))) ?? []).length > 0, name)
        }

        // Create, delete, another namespace, another workload.
        assert.ok((policy.Denials({ Operation: 'CREATE', Group: 'apps', Resource: 'deployments', Namespace: 'pragmatic-system', Object: agent, OldObject: null }) ?? []).length > 0, 'CREATE')
        assert.ok((policy.Denials({ Operation: 'DELETE', Group: 'apps', Resource: 'deployments', Namespace: 'pragmatic-system', Object: null, OldObject: agent }) ?? []).length > 0, 'DELETE')
        const elsewhere = AgentPolicy.Changed(agent, copy => { copy.metadata.namespace = 'kube-system' })
        assert.ok((policy.Denials({ ...update(elsewhere, moved(elsewhere, 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent' + digest)), Namespace: 'kube-system' }) ?? []).length > 0, 'another namespace')
        const env = AgentPolicy.Changed(console, copy => { copy.metadata.name = 'server'; copy.metadata.namespace = 'pragmatic-env-prod' })
        assert.ok((policy.Denials({ ...update(env, moved(env, 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server' + digest)), Namespace: 'pragmatic-env-prod' }) ?? []).length > 0, 'an environment is the console\'s')

        // A takeover by adding the managed-by label: required before as well as after.
        const unmanaged = AgentPolicy.Changed(agent, copy => { delete copy.metadata.labels['app.kubernetes.io/managed-by'] })
        assert.ok((policy.Denials(update(unmanaged, moved(agent, 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent' + digest))) ?? []).length > 0, 'UPDATE adding the label')

        // Namespaces: never, with or without Pod Security labels.
        for (const labels of [{}, { 'pod-security.kubernetes.io/enforce': 'restricted', 'pragmatic/hive': 'acme-hive' }])
        {
            const namespace = { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'pragmatic-env-x', labels } }
            assert.ok((policy.Denials({ Operation: 'CREATE', Group: '', Resource: 'namespaces', Namespace: '', Object: namespace, OldObject: null }) ?? []).length > 0, 'namespace CREATE')
            assert.ok((policy.Denials({ Operation: 'UPDATE', Group: '', Resource: 'namespaces', Namespace: '', Object: namespace, OldObject: namespace }) ?? []).length > 0, 'namespace UPDATE')
        }

        // Its own objects: by name, labelled; an unlabelled old one may be labelled (a C3.3 enrolment ConfigMap), never deleted.
        const own = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'pragmatic-hive-enrolment', namespace: 'pragmatic-system', labels: { 'app.kubernetes.io/managed-by': 'pragmatic-hive-agent' } } }
        const bare = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'pragmatic-hive-enrolment', namespace: 'pragmatic-system' } }
        const configMap = (operation: 'CREATE' | 'UPDATE' | 'DELETE', object: any, old: any, name?: string): AdmissionCase =>
            ({ Operation: operation, Group: '', Resource: 'configmaps', Namespace: 'pragmatic-system', Object: name === undefined ? object : AgentPolicy.Changed(object, copy => { copy.metadata.name = name }), OldObject: old })
        assert.deepEqual(policy.Denials(configMap('UPDATE', own, bare)), [])
        assert.deepEqual(policy.Denials(configMap('CREATE', AgentPolicy.Changed(own, copy => { copy.metadata.name = 'pragmatic-hive-intents' }), null)), [])
        assert.ok((policy.Denials(configMap('UPDATE', bare, bare)) ?? []).length > 0, 'an object without labels')
        assert.ok((policy.Denials(configMap('DELETE', null, own)) ?? []).length > 0, 'DELETE of its own')
        assert.ok((policy.Denials(configMap('CREATE', own, null, 'pragmatic-config-pragmatic-tenant-admin')) ?? []).length > 0, 'another ConfigMap')
        const secret = { ...own, kind: 'Secret', metadata: { ...own.metadata, name: 'pragmatic-owner-initial' } }
        assert.ok((policy.Denials({ Operation: 'UPDATE', Group: '', Resource: 'secrets', Namespace: 'pragmatic-system', Object: secret, OldObject: secret }) ?? []).length > 0, 'another Secret')

        // Round three: other kinds, a dropped container, an init-container field, a template label or annotation, a scale,
        // another repository, a service-account-token Secret.
        const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'pragmatic-hive-acme-hive-agent', namespace: 'pragmatic-system', labels: agent.metadata.labels }, spec: agent.spec.template.spec }
        assert.ok((policy.Denials({ Operation: 'CREATE', Group: '', Resource: 'pods', Namespace: 'pragmatic-system', Object: pod, OldObject: null }) ?? []).length > 0, 'a bare Pod')
        const job = { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'pragmatic-hive-acme-hive-agent', namespace: 'pragmatic-system', labels: agent.metadata.labels }, spec: { template: agent.spec.template } }
        assert.ok((policy.Denials({ Operation: 'CREATE', Group: 'batch', Resource: 'jobs', Namespace: 'pragmatic-system', Object: job, OldObject: null }) ?? []).length > 0, 'a Job')
        const replicaSet = AgentPolicy.Changed(agent, copy => { copy.kind = 'ReplicaSet' })
        assert.ok((policy.Denials({ Operation: 'UPDATE', Group: 'apps', Resource: 'replicasets', Namespace: 'pragmatic-system', Object: replicaSet, OldObject: replicaSet }) ?? []).length > 0, 'a ReplicaSet')
        const twoContainers = AgentPolicy.Changed(console, copy => { copy.spec.template.spec.containers.push({ ...copy.spec.template.spec.containers[0], name: 'second' }) })
        assert.ok((policy.Denials(update(twoContainers, AgentPolicy.Changed(twoContainers, copy => { copy.spec.template.spec.containers.pop() }))) ?? []).length > 0, 'a dropped container')
        assert.ok((policy.Denials(update(console, AgentPolicy.Changed(console, copy => { copy.spec.template.spec.initContainers[0].command = ['sh', '-c', 'id'] }))) ?? []).length > 0, 'an init-container field')
        assert.ok((policy.Denials(update(agent, AgentPolicy.Changed(agent, copy => { copy.spec.template.metadata.labels['app.kubernetes.io/component'] = 'pragmatic-tenant-admin' }))) ?? []).length > 0, 'an added template label')
        assert.ok((policy.Denials(update(agent, AgentPolicy.Changed(agent, copy => { copy.spec.template.metadata.annotations = { 'container.apparmor.security.beta.kubernetes.io/agent': 'unconfined' } }))) ?? []).length > 0, 'a template annotation')
        assert.ok((policy.Denials(update(agent, AgentPolicy.Changed(agent, copy => { copy.spec.replicas = 0 }))) ?? []).length > 0, 'a scaled replica count')
        assert.ok((policy.Denials(update(agent, AgentPolicy.Changed(agent, copy => { copy.spec.strategy = { type: 'Recreate' } }))) ?? []).length > 0, 'a changed strategy')
        assert.ok((policy.Denials(update(agent, moved(agent, 'ghcr.io/pragmatic-tech-ai/pragmatic-tenant-admin' + digest))) ?? []).length > 0, 'another release repository')
        const identity = (type: string, annotations?: Record<string, string>): AdmissionCase => ({
            Operation: 'CREATE', Group: '', Resource: 'secrets', Namespace: 'pragmatic-system', OldObject: null,
            Object: { apiVersion: 'v1', kind: 'Secret', type, metadata: { name: 'pragmatic-hive-identity', namespace: 'pragmatic-system', labels: { 'app.kubernetes.io/managed-by': 'pragmatic-hive-agent' }, ...(annotations === undefined ? {} : { annotations }) } },
        })
        assert.deepEqual(policy.Denials(identity('Opaque')), [])
        assert.ok((policy.Denials(identity('kubernetes.io/service-account-token', { 'kubernetes.io/service-account.name': 'pragmatic-tenant-admin-acme' })) ?? []).length > 0, 'a service-account-token Secret')
        assert.ok((policy.Denials(identity('Opaque', { 'kubernetes.io/service-account.name': 'pragmatic-tenant-admin-acme' })) ?? []).length > 0, 'the service-account annotation')
        assert.ok((policy.Denials({ ...identity('Opaque'), Object: { ...identity('Opaque').Object, metadata: { ...identity('Opaque').Object.metadata, name: 'pragmatic-tls-dev-ca-key' } } }) ?? []).length > 0, 'the dev CA key')

        // Anyone else is not this policy's.
        assert.equal(policy.Denials({ ...update(agent, moved(agent, 'docker.io/x/y:1')), Username: 'system:serviceaccount:pragmatic-system:pragmatic-tenant-admin-acme' }), null)

        // The engine's own objects carry a managed-by the policy admits.
        for (const workload of docs.filter(d => ['Deployment', 'StatefulSet'].includes(d.kind)))
        {
            assert.ok(['pragmatic-hive-agent', 'pragmatic-tenant-admin', 'pragmatic-engine'].includes(workload.metadata.labels?.['app.kubernetes.io/managed-by'] ?? ''), workload.kind + '/' + workload.metadata.name)
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
        assert.match(String(consoleEnv.get('PRAGMATIC_ENGINE_VERSION')), /^\d+\.\d+\.\d+/, 'the engine version an environment intent may name')
        const configuration = ChartFixture.Find(docs, 'Role', 'pragmatic-tenant-admin-acme-configuration')!
        assert.ok((configuration.rules as any[]).some(rule => rule.resources.includes('secrets') && JSON.stringify(rule.resourceNames) === JSON.stringify(['pragmatic-console-tls', 'pragmatic-tls-dev-ca'])
            && JSON.stringify(rule.verbs) === JSON.stringify(['get', 'update', 'patch'])) === false, 'the old two-name rule is gone')
        assert.ok((configuration.rules as any[]).some(rule => rule.resources.includes('secrets') && JSON.stringify(rule.resourceNames) === JSON.stringify(['pragmatic-console-tls', 'pragmatic-tls-dev-ca', 'pragmatic-tls-dev-ca-key'])
            && JSON.stringify(rule.verbs) === JSON.stringify(['get', 'update', 'patch'])), 'the ingress-certificate renewal')
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
            assert.equal(kind, 'Role', 'no cluster-wide Secret access')
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
        ], 'no cluster-wide list: the report\'s environments come from the console')
        const cluster = docs.filter(d => d.kind === 'ClusterRole' && bound.some(binding => binding.roleRef.kind === 'ClusterRole' && binding.roleRef.name === d.metadata.name))
        for (const role of cluster)
        {
            for (const rule of role.rules as any[])
            {
                assert.ok(!(rule.verbs as string[]).some(verb => verb === 'list' || verb === 'watch' || verb === '*'), role.metadata.name + ' lists or watches nothing')
            }
        }
        const all = JSON.stringify(roles.map(role => role.rules))
        assert.equal(all.includes('pragmatic-tls-dev-ca-key'), false, 'nothing on the dev CA key')
    })

    it('the bootstrap Roles name exactly the Secrets EngineBootstrap reads and writes (pragmatic-tenant-admin df2232e)', () =>
    {
        // EngineSecretSet.Specs per scope (self-signed: the dev CA, its key and the console TLS Secret), by name.
        const engine = [
            'pragmatic-postgres-superuser', 'pragmatic-postgres-app-tenant-admin', 'pragmatic-postgres-app-tenant-idp', 'pragmatic-tenant-admin-master-key',
            'pragmatic-tenant-admin-fingerprint', 'pragmatic-tenant-admin-seed', 'pragmatic-tenant-idp-admin-token', 'pragmatic-owner-initial', 'pragmatic-tenant-idp-ca',
            'pragmatic-tls-dev-ca', 'pragmatic-tls-dev-ca-key', 'pragmatic-realm-master-key', 'pragmatic-postgres-realm-secrets-console', 'pragmatic-postgres-realm-secrets-idp',
            'pragmatic-postgres-realm-secrets-environments', 'pragmatic-console-tls',
        ]
        const idp = [
            'pragmatic-tenant-idp-master-key', 'pragmatic-tenant-idp-signing-key', 'pragmatic-tenant-idp-tls', 'pragmatic-tenant-idp-admin-token', 'pragmatic-tenant-idp-database',
            'pragmatic-realm-master-key', 'pragmatic-tenant-idp-realm-secrets', 'pragmatic-console-tls',
        ]
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const named = (namespace: string): string[] => ((docs.find(d => d.kind === 'Role' && d.metadata.name === 'pragmatic-engine-bootstrap' && d.metadata.namespace === namespace)!.rules as any[])
            .find(rule => rule.resources.includes('secrets') && rule.resourceNames !== undefined).resourceNames as string[]).slice().sort()
        assert.deepEqual(named('pragmatic-system'), [...engine].sort())
        assert.deepEqual(named('pragmatic-idp-acme'), [...idp].sort())
    })

    it('the bootstrap enforces the restricted Pod Security level on the engine\'s two namespaces', () =>
    {
        const docs = ChartFixture.Render(RenderFixture.Connected)
        const role = ChartFixture.Find(docs, 'ClusterRole', 'pragmatic-engine-namespace')!
        assert.ok((role.rules as any[]).some(rule => JSON.stringify(rule.resourceNames) === JSON.stringify(['pragmatic-idp-acme', 'pragmatic-system']) && JSON.stringify(rule.verbs) === JSON.stringify(['get', 'patch'])))
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
