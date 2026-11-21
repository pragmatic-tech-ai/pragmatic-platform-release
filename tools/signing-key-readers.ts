import { ReleaseApps } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { ReleaseCliOutput } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** GitHub could not be asked, or a repository has no workflows folder. A fixed sentence followed by the repository. */
export class SigningKeyReadersError extends Error
{
    private static readonly ErrorName = 'SigningKeyReadersError'

    public constructor(message: string)
    {
        super(message)
        this.name = SigningKeyReadersError.ErrorName
    }
}

export type SigningKeyFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>

/** What a scan found: how many workflow files it read, and each one that reads the key, as `<repo>/<file>`. */
export type SigningKeyReadersResult = { readonly Workflows: number; readonly Readers: readonly string[] }

/**
 * Reads the workflow files of other repositories of the organisation through GitHub's contents API (public, read-only)
 * and names every one that reads RELEASE_SIGNING_KEY outside a comment line. CI runs it so the rule "only this
 * repository's release.yml reads the key" holds without sibling clones.
 */
export class SigningKeyReaders
{
    public static readonly SigningKey = 'RELEASE_SIGNING_KEY'
    private static readonly DefaultApi = 'https://api.github.com'
    private static readonly ReposPrefix = '/repos/'
    private static readonly ContentsInfix = '/contents/'
    private static readonly WorkflowsPath = '.github/workflows'
    private static readonly PathSeparator = '/'
    private static readonly LineBreak = '\n'
    private static readonly WorkflowPattern = /\.ya?ml$/
    private static readonly CommentPattern = /^\s*#/
    private static readonly FileType = 'file'
    private static readonly AuthorizationHeader = 'Authorization'
    private static readonly AcceptHeader = 'Accept'
    private static readonly BearerPrefix = 'Bearer '
    private static readonly ListType = 'application/vnd.github+json'
    private static readonly RawType = 'application/vnd.github.raw+json'
    private static readonly StatusNotFound = 404
    private static readonly NoWorkflowsPrefix = 'Repository has no workflows folder (renamed or deleted?): '
    private static readonly UnavailablePrefix = 'GitHub did not answer the workflow read for '
    private static readonly UnreadablePrefix = 'GitHub answered an unreadable workflow listing for '

    public constructor(private readonly owner: string, private readonly fetchFn: SigningKeyFetch = fetch, private readonly token?: string,
        private readonly api: string = SigningKeyReaders.DefaultApi)
    {
    }

    /** Scans every workflow of each of `repos` (names inside the owner); throws for a repository it cannot read. */
    public async Find(repos: readonly string[]): Promise<SigningKeyReadersResult>
    {
        const S = SigningKeyReaders
        const readers: string[] = []
        let workflows = 0
        for (const repo of repos)
        {
            for (const name of await this.WorkflowNames(repo))
            {
                workflows++
                const text = await this.Read(repo, S.WorkflowsPath + S.PathSeparator + name, S.RawType)
                if (S.Reads(await text.text()))
                {
                    readers.push(repo + S.PathSeparator + name)
                }
            }
        }
        return { Workflows: workflows, Readers: readers }
    }

    /** The key appears in a line that is not a comment. */
    public static Reads(text: string): boolean
    {
        const S = SigningKeyReaders
        return text.split(S.LineBreak).some(line => !S.CommentPattern.test(line) && line.includes(S.SigningKey))
    }

    private async WorkflowNames(repo: string): Promise<string[]>
    {
        const S = SigningKeyReaders
        const listing: unknown = await (await this.Read(repo, S.WorkflowsPath, S.ListType)).json().catch(() => undefined)
        if (!Array.isArray(listing))
        {
            throw new SigningKeyReadersError(S.UnreadablePrefix + repo)
        }
        return listing
            .filter((entry): entry is { name: string; type: string } => typeof entry?.name === 'string' && entry.type === S.FileType)
            .map(entry => entry.name)
            .filter(name => S.WorkflowPattern.test(name))
    }

    private async Read(repo: string, path: string, accept: string): Promise<Response>
    {
        const S = SigningKeyReaders
        const headers: Record<string, string> = { [S.AcceptHeader]: accept }
        if (this.token !== undefined && this.token.length > 0)
        {
            headers[S.AuthorizationHeader] = S.BearerPrefix + this.token
        }
        let response: Response
        try
        {
            response = await this.fetchFn(this.api + S.ReposPrefix + this.owner + S.PathSeparator + repo + S.ContentsInfix + path, { headers })
        }
        catch
        {
            throw new SigningKeyReadersError(S.UnavailablePrefix + repo)
        }
        if (response.status === S.StatusNotFound && path === S.WorkflowsPath)
        {
            throw new SigningKeyReadersError(S.NoWorkflowsPrefix + repo)
        }
        if (!response.ok)
        {
            throw new SigningKeyReadersError(S.UnavailablePrefix + repo)
        }
        return response
    }
}

/**
 * `signing-key-readers`: CI's check that no workflow of the organisation's other new repositories (the nine container
 * repositories, pragmatic-e2e, pragmatic-shared) reads RELEASE_SIGNING_KEY. GITHUB_TOKEN, when set, is sent as a bearer
 * (rate limit); the repositories are public.
 */
export class SigningKeyReadersCli
{
    public static readonly Owner = 'pragmatic-tech-ai'
    public static readonly DefaultRepos: readonly string[] = [...ReleaseApps.All, 'pragmatic-e2e', 'pragmatic-shared']
    private static readonly EnvToken = 'GITHUB_TOKEN'
    private static readonly CheckedPrefix = 'checked '
    private static readonly ReposInfix = ' repositories, '
    private static readonly CleanSuffix = ' workflows: no workflow reads ' + SigningKeyReaders.SigningKey
    private static readonly ReaderPrefix = 'reads ' + SigningKeyReaders.SigningKey + ': '
    private static readonly OkExitCode = 0
    private static readonly FailExitCode = 1

    /** `fetchFn` and `repos` replace GitHub and the repository list (tests). */
    public static async Run(env: NodeJS.ProcessEnv, output: ReleaseCliOutput, fetchFn?: SigningKeyFetch,
        repos: readonly string[] = SigningKeyReadersCli.DefaultRepos): Promise<number>
    {
        const S = SigningKeyReadersCli
        try
        {
            const result = await new SigningKeyReaders(S.Owner, fetchFn, env[S.EnvToken]).Find(repos)
            if (result.Readers.length > 0)
            {
                for (const reader of result.Readers)
                {
                    output.Err(S.ReaderPrefix + reader)
                }
                return S.FailExitCode
            }
            output.Out(S.CheckedPrefix + repos.length + S.ReposInfix + result.Workflows + S.CleanSuffix)
            return S.OkExitCode
        }
        catch (err)
        {
            output.Err(err instanceof Error ? err.message : String(err))
            return S.FailExitCode
        }
    }
}
