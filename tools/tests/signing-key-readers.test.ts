import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SigningKeyReaders, SigningKeyReadersCli, SigningKeyReadersError } from '../signing-key-readers.js'

/**
 * GitHub's contents API in memory: `<repo>` → workflow file name → text. A repository listed in `missing` answers 404 for
 * its workflows folder; `failing` answers 500 everywhere.
 */
class FakeGitHub
{
    private static readonly Api = 'https://api.github.com'
    private static readonly ContentsInfix = '/contents/'
    private static readonly ReposPrefix = '/repos/'
    private static readonly WorkflowsPath = '.github/workflows'
    private static readonly PathSeparator = '/'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly AcceptHeader = 'Accept'
    private static readonly RawType = 'application/vnd.github.raw+json'
    private static readonly FileType = 'file'
    private static readonly DirType = 'dir'
    private static readonly NestedDir = 'nested'
    private static readonly StatusOk = 200
    private static readonly StatusNotFound = 404
    private static readonly StatusError = 500

    public readonly Requests: string[] = []
    public readonly Authorizations: (string | undefined)[] = []
    public readonly Repos = new Map<string, Map<string, string>>()
    public readonly Missing = new Set<string>()
    public Failing = false

    public static ContentsUrl(repo: string, path: string): string
    {
        return FakeGitHub.Api + FakeGitHub.ReposPrefix + repo + FakeGitHub.ContentsInfix + path
    }

    public readonly Fetch = async (url: string, init?: { headers?: Record<string, string> }): Promise<Response> =>
    {
        const S = FakeGitHub
        this.Requests.push(url)
        this.Authorizations.push(init?.headers?.[S.AuthorizationHeader])
        if (this.Failing)
        {
            return new Response(null, { status: S.StatusError })
        }
        for (const [repo, files] of this.Repos)
        {
            if (this.Missing.has(repo))
            {
                continue
            }
            if (url === S.ContentsUrl(repo, S.WorkflowsPath))
            {
                const listing = [...files.keys()].map(name => ({ name, path: S.WorkflowsPath + S.PathSeparator + name, type: S.FileType }))
                listing.push({ name: S.NestedDir, path: S.WorkflowsPath + S.PathSeparator + S.NestedDir, type: S.DirType })
                return Response.json(listing, { status: S.StatusOk })
            }
            for (const [name, text] of files)
            {
                if (url === S.ContentsUrl(repo, S.WorkflowsPath + S.PathSeparator + name))
                {
                    assert.equal(init?.headers?.[S.AcceptHeader], S.RawType)
                    return new Response(text, { status: S.StatusOk })
                }
            }
        }
        return new Response(null, { status: S.StatusNotFound })
    }
}

class ReadersFixture
{
    public static readonly Owner = 'pragmatic-tech-ai'
    public static readonly Postgres = 'pragmatic-postgres'
    public static readonly E2e = 'pragmatic-e2e'
    public static readonly Shared = 'pragmatic-shared'
    public static readonly Repos: readonly string[] = [ReadersFixture.Postgres, ReadersFixture.E2e, ReadersFixture.Shared]
    public static readonly Publish = 'publish.yaml'
    public static readonly Ci = 'ci.yml'
    public static readonly Release = 'release.yml'
    public static readonly Readme = 'README.md'
    public static readonly CleanWorkflow = 'jobs:\n  ci:\n    steps:\n      - run: npm test\n'
    public static readonly ReaderWorkflow = 'jobs:\n  sign:\n    steps:\n      - env:\n          KEY: ${{ secrets.RELEASE_SIGNING_KEY }}\n'
    public static readonly CommentOnly = '# never reads RELEASE_SIGNING_KEY (that is pragmatic-platform-release only)\njobs: {}\n'
    public static readonly Token = 'ghs_test_token'
    public static readonly BearerPrefix = 'Bearer '
    public static readonly PathSeparator = '/'
    public static readonly Checked = /^checked 3 repositories, 5 workflows: no workflow reads RELEASE_SIGNING_KEY$/

    public readonly GitHub = new FakeGitHub()
    public readonly Out: string[] = []
    public readonly Err: string[] = []
    public readonly Output = { Out: (line: string) => { this.Out.push(line) }, Err: (line: string) => { this.Err.push(line) } }

    /** Every repository with clean workflows (pragmatic-shared with three). */
    public constructor()
    {
        const F = ReadersFixture
        for (const repo of F.Repos)
        {
            this.GitHub.Repos.set(F.Owner + F.PathSeparator + repo, new Map([[F.Ci, F.CleanWorkflow]]))
        }
        const shared = this.GitHub.Repos.get(F.Owner + F.PathSeparator + F.Shared) as Map<string, string>
        shared.set(F.Release, F.CommentOnly)
        shared.set(F.Publish, F.CleanWorkflow)
        shared.set(F.Readme, F.ReaderWorkflow)
    }

    public Readers(token?: string): SigningKeyReaders
    {
        return new SigningKeyReaders(ReadersFixture.Owner, this.GitHub.Fetch, token)
    }
}

describe('SigningKeyReaders', () =>
{
    const F = ReadersFixture

    it('finds no reader among clean workflows; a comment naming the key is not a read; non-workflow files are ignored', async () =>
    {
        const fixture = new F()
        const result = await fixture.Readers().Find(F.Repos)
        assert.deepEqual(result.Readers, [])
        assert.equal(result.Workflows, 5)
    })

    it('names every workflow that reads RELEASE_SIGNING_KEY as <repo>/<file>', async () =>
    {
        const fixture = new F()
        fixture.GitHub.Repos.get(F.Owner + F.PathSeparator + F.Postgres)?.set(F.Release, F.ReaderWorkflow)
        const result = await fixture.Readers().Find(F.Repos)
        assert.deepEqual(result.Readers, [F.Postgres + F.PathSeparator + F.Release])
    })

    it('refuses a repository without a workflows folder, naming it (a renamed or deleted sibling is not skipped)', async () =>
    {
        const fixture = new F()
        fixture.GitHub.Missing.add(F.Owner + F.PathSeparator + F.E2e)
        await assert.rejects(fixture.Readers().Find(F.Repos), (err: Error) =>
            err instanceof SigningKeyReadersError && err.message.endsWith(F.E2e))
    })

    it('refuses when GitHub fails, without the response body', async () =>
    {
        const fixture = new F()
        fixture.GitHub.Failing = true
        await assert.rejects(fixture.Readers().Find(F.Repos), SigningKeyReadersError)
    })

    it('sends the token as a bearer only when one is given', async () =>
    {
        const withToken = new F()
        await withToken.Readers(F.Token).Find(F.Repos)
        assert.ok(withToken.GitHub.Authorizations.every(header => header === F.BearerPrefix + F.Token))
        const without = new F()
        await without.Readers().Find(F.Repos)
        assert.ok(without.GitHub.Authorizations.every(header => header === undefined))
    })
})

describe('SigningKeyReadersCli', () =>
{
    const F = ReadersFixture

    it('checks the organisation\'s new repositories and passes when none reads the key', async () =>
    {
        const fixture = new F()
        assert.equal(await SigningKeyReadersCli.Run({}, fixture.Output, fixture.GitHub.Fetch, F.Repos), 0)
        assert.match(fixture.Out[0], F.Checked)
        assert.deepEqual(fixture.Err, [])
    })

    it('fails naming each reader', async () =>
    {
        const fixture = new F()
        fixture.GitHub.Repos.get(F.Owner + F.PathSeparator + F.E2e)?.set(F.Release, F.ReaderWorkflow)
        assert.equal(await SigningKeyReadersCli.Run({}, fixture.Output, fixture.GitHub.Fetch, F.Repos), 1)
        assert.equal(fixture.Err.length, 1)
        assert.ok(fixture.Err[0].endsWith(F.E2e + F.PathSeparator + F.Release), fixture.Err[0])
    })

    it('fails, not skips, when GitHub cannot be asked', async () =>
    {
        const fixture = new F()
        fixture.GitHub.Failing = true
        assert.equal(await SigningKeyReadersCli.Run({}, fixture.Output, fixture.GitHub.Fetch, F.Repos), 1)
        assert.deepEqual(fixture.Out, [])
    })

    it('by default checks the ten container repositories, pragmatic-e2e and pragmatic-shared', () =>
    {
        assert.equal(SigningKeyReadersCli.DefaultRepos.length, 12)
        assert.ok(SigningKeyReadersCli.DefaultRepos.includes(F.E2e))
        assert.ok(SigningKeyReadersCli.DefaultRepos.includes(F.Shared))
        assert.ok(!SigningKeyReadersCli.DefaultRepos.includes('pragmatic-platform-release'))
    })
})
