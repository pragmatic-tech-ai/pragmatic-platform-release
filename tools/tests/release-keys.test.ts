import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ReleaseTrustKeys } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

/** This repository's release-keys: the trust release.yml publishes against (the platform console ships its own copy). */
class ShippedKeys
{
    public static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    public static readonly Dir = join(ShippedKeys.Root, ReleaseTrustKeys.DirName)
    public static readonly KeyId = 'release-2026-11'
    public static readonly ReleaseWorkflow = join(ShippedKeys.Root, '.github', 'workflows', 'release.yml')
    public static readonly KeyIdFlag = /--key-id (\S+)/g
    public static readonly Utf8 = 'utf8'
}

describe('release-keys', () =>
{
    const K = ShippedKeys

    it('loads the committed release-keys directory, which holds the shipped key', () =>
    {
        const keys = ReleaseTrustKeys.FromDirectory(K.Dir)
        assert.ok(keys.Ids.includes(K.KeyId))
        assert.ok(keys.KeyFor(K.KeyId) !== undefined)
    })

    it('every --key-id release.yml signs with has its public key here', () =>
    {
        const keys = ReleaseTrustKeys.FromDirectory(K.Dir)
        const ids = [...readFileSync(K.ReleaseWorkflow, K.Utf8).matchAll(K.KeyIdFlag)].map(match => match[1])
        assert.ok(ids.length > 0)
        for (const id of ids)
        {
            assert.ok(keys.KeyFor(id) !== undefined, id)
        }
    })
})
