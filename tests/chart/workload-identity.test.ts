import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseAllDocuments } from 'yaml'
import { ChartFixture, type K8sDoc } from './chart-fixture.js'

/** The realm secrets home in the chart (2.5 Task 6): every option's render. */
class RealmFixture
{
    public static readonly Audience = '//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/pragmatic-hives/providers/pragmatic-customer'
    public static readonly Base = { 'tls.mode': 'self-signed' }
    public static readonly Gcp = { ...RealmFixture.Base, 'realmSecrets.option': 'gcp', 'realmSecrets.gcp.projectId': 'pragmatic-ops', 'realmSecrets.gcp.workloadIdentityAudience': RealmFixture.Audience }
    public static readonly Azure = {
        ...RealmFixture.Base, 'realmSecrets.option': 'azure', 'realmSecrets.azure.tenantId': '00000000-0000-0000-0000-00000000000a',
        'realmSecrets.azure.clientId': '00000000-0000-0000-0000-00000000000b', 'realmSecrets.azure.vaultUrl': 'https://acme-realm.vault.azure.net',
    }
    public static readonly Aws = { ...RealmFixture.Base, 'realmSecrets.option': 'aws', 'realmSecrets.aws.region': 'eu-west-1', 'realmSecrets.aws.roleArn': 'arn:aws:iam::123456789012:role/acme-realm' }
    public static readonly Console = 'pragmatic-tenant-admin-acme'
    public static readonly Idp = 'pragmatic-idp-acme'

    public static Pod(docs: readonly K8sDoc[], name: string): { env: Record<string, string>; mounts: any[]; volumes: any[]; labels: Record<string, string> }
    {
        const deployment = ChartFixture.Find(docs, 'Deployment', name)!
        const spec = deployment.spec.template.spec
        const container = spec.containers[0]
        return {
            env: Object.fromEntries((container.env as any[]).filter(e => e.value !== undefined).map(e => [e.name, e.value])),
            mounts: container.volumeMounts,
            volumes: spec.volumes,
            labels: deployment.spec.template.metadata.labels,
        }
    }

    public static Account(docs: readonly K8sDoc[], name: string): K8sDoc
    {
        return ChartFixture.Find(docs, 'ServiceAccount', name)!
    }

    public static Token(volumes: any[]): any
    {
        return volumes.find(v => v.name === 'realm-workload-identity')?.projected.sources[0].serviceAccountToken
    }

    public static CheckGolden(name: string, text: string): void
    {
        const file = join(ChartFixture.Golden, name + '.yaml')
        const documents = (t: string) => parseAllDocuments(t).map(d => d.toJS()).filter(d => d !== null && d !== undefined)
        if (process.env.UPDATE_GOLDEN === '1')
        {
            mkdirSync(ChartFixture.Golden, { recursive: true })
            writeFileSync(file, text)
            return
        }
        assert.deepEqual(documents(text), documents(readFileSync(file, 'utf8')), name + ': the render changed; rerun with UPDATE_GOLDEN=1 and review the golden diff')
    }
}

describe('the pragmatic-engine chart: the realm secrets home', { skip: !ChartFixture.HasHelm() }, () =>
{
    it('custom (the default) renders no cloud annotation and mounts the master key into the console and the sign-in service only', () =>
    {
        const docs = ChartFixture.Render(RealmFixture.Base)
        for (const account of docs.filter(d => d.kind === 'ServiceAccount'))
        {
            assert.equal(account.metadata.annotations?.['iam.gke.io/gcp-service-account'] ?? account.metadata.annotations?.['azure.workload.identity/client-id'] ?? account.metadata.annotations?.['eks.amazonaws.com/role-arn'], undefined, account.metadata.name)
        }
        const keyed = ChartFixture.Pods(docs).filter(p => (p.spec.volumes as any[] ?? []).some(v => v.secret?.secretName === 'pragmatic-realm-master-key')).map(p => p.owner).sort()
        assert.deepEqual(keyed, ['Deployment/' + RealmFixture.Idp, 'Deployment/' + RealmFixture.Console], 'the environments\' servers get their copy from the console')
        for (const name of [RealmFixture.Console, RealmFixture.Idp])
        {
            const pod = RealmFixture.Pod(docs, name)
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_OPTION, 'custom')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_ACCESS, 'writer', 'the two writers of the home')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_DATABASE_URL_FILE, '/run/secrets/pragmatic-realm-secrets/database-url')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_MASTER_KEY_FILE, '/run/secrets/pragmatic-realm-master-key/master.key')
            assert.equal(pod.env.PRAGMATIC_REALM_ID, 'acme', 'one realm id for the console and the sign-in service')
            assert.equal(pod.env.PRAGMATIC_WORKLOAD_TOKEN_FILE, undefined)
            assert.equal(RealmFixture.Token(pod.volumes), undefined, 'no workload identity for the custom home')
        }
        const console = RealmFixture.Pod(docs, RealmFixture.Console)
        assert.equal(console.env.PRAGMATIC_COMPONENT, 'pragmatic-tenant-admin')
        assert.equal(console.volumes.find(v => v.name === 'realm-secrets-database').secret.secretName, 'pragmatic-postgres-realm-secrets-console')
        assert.deepEqual(console.volumes.find(v => v.name === 'realm-secrets-roles').projected.sources.map((s: any) => s.secret.items[0]), [
            { key: 'password', path: 'console' }, { key: 'password', path: 'idp' }, { key: 'password', path: 'environments' },
        ])
        assert.equal(console.env.PRAGMATIC_TENANT_ADMIN_REALM_SECRETS_READER_URL_FILE, '/run/secrets/realm-secrets-reader/database-url')
        const idp = RealmFixture.Pod(docs, RealmFixture.Idp)
        assert.equal(idp.env.PRAGMATIC_COMPONENT, 'pragmatic-tenant-idp')
        assert.equal(idp.volumes.find(v => v.name === 'realm-secrets-database').secret.secretName, 'pragmatic-tenant-idp-realm-secrets')
        assert.equal(idp.volumes.some(v => v.name === 'realm-secrets-roles'), false, 'only the console provisions the home')
    })

    it('gcp renders the projected token with the pool audience into the console and the sign-in service, and no master key', () =>
    {
        const docs = ChartFixture.Render(RealmFixture.Gcp)
        for (const name of [RealmFixture.Console, RealmFixture.Idp])
        {
            const pod = RealmFixture.Pod(docs, name)
            assert.deepEqual(RealmFixture.Token(pod.volumes), { audience: RealmFixture.Audience, expirationSeconds: 3600, path: 'token' }, name)
            assert.ok(pod.mounts.some(m => m.name === 'realm-workload-identity' && m.mountPath === '/var/run/secrets/pragmatic/workload-identity' && m.readOnly === true))
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_OPTION, 'gcp')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_PROJECT_ID, 'pragmatic-ops')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_WORKLOAD_IDENTITY_AUDIENCE, RealmFixture.Audience)
            assert.equal(pod.env.PRAGMATIC_WORKLOAD_TOKEN_FILE, '/var/run/secrets/pragmatic/workload-identity/token')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_ACCESS, undefined)
            assert.equal(pod.volumes.some(v => v.secret?.secretName === 'pragmatic-realm-master-key'), false)
        }
        assert.equal(RealmFixture.Pod(docs, RealmFixture.Console).env.PRAGMATIC_TENANT_ADMIN_REALM_SECRETS_ROLES_DIR, undefined)
        const impersonating = ChartFixture.Render({ ...RealmFixture.Gcp, 'realmSecrets.gcp.serviceAccountEmail': 'acme-realm@pragmatic-ops.iam.gserviceaccount.com' })
        assert.equal(RealmFixture.Pod(impersonating, RealmFixture.Idp).env.PRAGMATIC_REALM_SECRETS_SERVICE_ACCOUNT_EMAIL, 'acme-realm@pragmatic-ops.iam.gserviceaccount.com')
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Gcp, 'realmSecrets.gcp.gke': 'true' }), /additional propert/i, 'no GKE annotation switch: nothing ambient')
    })

    it('azure renders the client id and the token exchange audience, and no webhook label or annotation (nothing ambient)', () =>
    {
        const docs = ChartFixture.Render(RealmFixture.Azure)
        for (const name of [RealmFixture.Console, RealmFixture.Idp])
        {
            assert.equal(RealmFixture.Account(docs, name).metadata.annotations, undefined)
            const pod = RealmFixture.Pod(docs, name)
            assert.equal(pod.labels['azure.workload.identity/use'], undefined, 'the AKS webhook would inject ambient AZURE_* variables')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_CLIENT_ID, '00000000-0000-0000-0000-00000000000b')
            assert.equal(RealmFixture.Token(pod.volumes).audience, 'api://AzureADTokenExchange')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_VAULT_URL, 'https://acme-realm.vault.azure.net')
        }
    })

    it('aws renders the role ARN as a setting and the STS audience, and no EKS annotation (nothing ambient)', () =>
    {
        const docs = ChartFixture.Render(RealmFixture.Aws)
        for (const name of [RealmFixture.Console, RealmFixture.Idp])
        {
            assert.equal(RealmFixture.Account(docs, name).metadata.annotations, undefined, 'the EKS webhook would inject AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE')
            const pod = RealmFixture.Pod(docs, name)
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_ROLE_ARN, 'arn:aws:iam::123456789012:role/acme-realm')
            assert.equal(RealmFixture.Token(pod.volumes).audience, 'sts.amazonaws.com')
            assert.equal(pod.env.PRAGMATIC_REALM_SECRETS_REGION, 'eu-west-1')
        }
    })

    it('a key-shaped value or setting fails the schema', () =>
    {
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Gcp, 'realmSecrets.gcp.credentialsJson': '{}' }), /additional propert/i)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Aws, 'realmSecrets.aws.accessKeyId': 'AKIAABCDEFGHIJKLMNOP' }), /additional propert/i)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Azure, 'realmSecrets.azure.clientSecret': 'x' }), /additional propert/i)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Gcp, 'realmSecrets.gcp.serviceAccountEmail': '-----BEGIN PRIVATE KEY-----' }), /serviceAccountEmail/)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Aws, 'realmSecrets.aws.roleArn': 'AKIAABCDEFGHIJKLMNOP' }), /roleArn/)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Base, 'realmSecrets.option': 'vault' }), /option/)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Aws, 'realmSecrets.aws.sessionName': 'AKIAABCDEFGHIJKLMNOP' }), /sessionName/, 'an access key id')
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Aws, 'realmSecrets.aws.sessionName': 'Ab1+'.repeat(10) }), /sessionName/, 'a 40-character secret key')
        assert.equal(ChartFixture.Render({ ...RealmFixture.Aws, 'realmSecrets.aws.sessionName': 'console-1' }).length > 0, true)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Azure, 'realmSecrets.azure.vaultUrl': 'https://acme--realm.vault.azure.net' }), /vaultUrl/, 'Key Vault names hold no "--"')
    })

    it('a cloud option without its identifiers is refused naming them', () =>
    {
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Base, 'realmSecrets.option': 'gcp', 'realmSecrets.gcp.projectId': 'pragmatic-ops' }), /realmSecrets\.gcp\.workloadIdentityAudience/)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Base, 'realmSecrets.option': 'aws', 'realmSecrets.aws.region': 'eu-west-1' }), /realmSecrets\.aws\.roleArn/)
        assert.match(ChartFixture.Refusal({ ...RealmFixture.Base, 'realmSecrets.option': 'azure' }), /realmSecrets\.azure\.tenantId/)
    })

    it('the preflight is told the option and may read the cluster\'s issuer discovery document', () =>
    {
        const docs = ChartFixture.Render(RealmFixture.Aws)
        const job = ChartFixture.Find(docs, 'Job', 'pragmatic-engine-preflight')!
        const env = job.spec.template.spec.containers[0].env as any[]
        assert.equal(env.find(e => e.name === 'PRAGMATIC_PREFLIGHT_REALM_SECRETS_OPTION')?.value, 'aws')
        const role = ChartFixture.Find(docs, 'ClusterRole', 'pragmatic-engine-preflight')!
        assert.ok((role.rules ?? []).some((r: any) => (r.nonResourceURLs ?? []).includes('/.well-known/openid-configuration')))
    })

    it('the bootstrap may read and write the realm secrets home\'s Secrets by name', () =>
    {
        const docs = ChartFixture.Render(RealmFixture.Base)
        const names = (namespace: string) => (docs.find(d => d.kind === 'Role' && d.metadata.name === 'pragmatic-engine-bootstrap' && d.metadata.namespace === namespace)!.rules!.find((r: any) => r.verbs.includes('get')).resourceNames as string[])
        for (const name of ['pragmatic-realm-master-key', 'pragmatic-postgres-realm-secrets-console', 'pragmatic-postgres-realm-secrets-idp', 'pragmatic-postgres-realm-secrets-environments'])
        {
            assert.ok(names('pragmatic-system').includes(name), name)
        }
        for (const name of ['pragmatic-realm-master-key', 'pragmatic-tenant-idp-realm-secrets'])
        {
            assert.ok(names('pragmatic-idp-acme').includes(name), name)
        }
    })

    it('the console may create the environment server’s own account in an environment namespace', () =>
    {
        const role = ChartFixture.Find(ChartFixture.Render(RealmFixture.Base), 'ClusterRole', 'pragmatic-tenant-admin-acme-env')!
        assert.ok((role.rules ?? []).some((r: any) => (r.resources as string[]).includes('serviceaccounts')))
    })

    it('the chart lands only with the component versions that read the realm secrets home', () =>
    {
        const release = JSON.parse(readFileSync(join(ChartFixture.Root, 'release.json'), 'utf8')) as { components: Record<string, { version: string }> }
        const minimum: Record<string, string> = { 'pragmatic-tenant-admin': '0.1.11', 'pragmatic-tenant-idp': '0.2.8', 'pragmatic-env-server': '0.1.4', 'pragmatic-hive-agent': '0.1.8' }
        const parts = (v: string) => v.split('.').map(Number)
        for (const [app, first] of Object.entries(minimum))
        {
            const [a, b, c] = parts(release.components[app]!.version)
            const [x, y, z] = parts(first)
            assert.ok(a! > x! || (a === x && (b! > y! || (b === y && c! >= z!))), app + ' ' + release.components[app]!.version + ' is older than ' + first + ', the first that reads the realm secrets home the chart mounts')
        }
    })

    it('goldens per cloud option', () =>
    {
        RealmFixture.CheckGolden('realm-gcp', ChartFixture.Text(RealmFixture.Gcp))
        RealmFixture.CheckGolden('realm-azure', ChartFixture.Text(RealmFixture.Azure))
        RealmFixture.CheckGolden('realm-aws', ChartFixture.Text(RealmFixture.Aws))
    })
})
