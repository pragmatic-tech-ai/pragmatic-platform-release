# pragmatic-platform-release

Assembles and signs a **platform release**: one signed release descriptor (schema 2) naming the nine container images
of the platform by digest, published as `ghcr.io/pragmatic-tech-ai/pragmatic-release:<version>`, which every platform
admin console's catalogue verifies against `release-keys/`. Nothing is built here: each container repository
(`pragmatic-tech-ai/<app>`) releases its own image from its tag `v<version>` (pragmatic-shared's
`container-release.yml`), pushed by digest, with `component.json` and `digest.txt` attached to its GitHub release.
This repository holds the release signing key; once pragmatic-server is archived (dev-kit A3 Task 14, which deletes its
copy) it is the only one.

| File | What |
|---|---|
| `release.json` | The release manifest: `{ "schema": 1, "version": "<X.Y.Z[-early.N]>", "components": { "<app>": { "repository": "pragmatic-tech-ai/<app>", "version": "<container release>", "digest": "sha256:…" } } }`, all nine apps (`ReleaseApps.All`), nothing else. |
| `release.template.json` | The manifest of `0.1.0-early.6` with placeholder digests; never read by `release-manifest ci` (a test holds that its placeholders are refused and that, filled, it is a valid manifest). |
| `release-keys/release-2026-11.pub.pem` | The public half of the signing key; `publish` refuses to push signatures it does not verify. |
| `tools/release-manifest.ts` | `PlatformReleaseManifest` (the toolkit's `ReleaseManifest.Parse` plus this repository's policy: every app from `pragmatic-tech-ai/<app>`; a release tag names the manifest version), `PublishedRelease` (whether the manifest's version is published, and whether its descriptor names the manifest's image digests; `RELEASE_NAMESPACE`, when set, must be `pragmatic-tech-ai`) and `ReleaseManifestCli` (`verify`, `ci`). |
| `.github/workflows/ci.yml` | Install (no install scripts), typecheck, tests, then `release-manifest ci`: no `release.json` passes; a published version passes only while the published descriptor names exactly the manifest's image digests (the last release); otherwise the toolkit's `pragmatic-release-publish assemble` checks it against the registry and the container releases. A missing `PACKAGES_TOKEN` fails the run, except on a fork's pull request (skipped with a warning). |
| `.github/workflows/release.yml` | On tag `release/*` only. Job `verify`: install (no install scripts), typecheck, tests, `verify --tag` (no valid `release.json` naming the tag's version: stop). Job `publish` (environment `release`): production install (no install scripts), `assemble`, then `publish --manifest release.json --key-id release-2026-11 --trust-dir release-keys` with `RELEASE_SIGNING_KEY`. Both jobs check out the tagged commit (`github.sha`); one release run at a time (push the next release tag after the previous run finished: a pending run superseded by a third tag is cancelled and must be re-run). |

The publish chain is `@pragmatic-tech-ai/pragmatic-release-toolkit` (`^0.17.6`, see its README): `assemble --manifest`
checks each image exists at its digest, carries a component label equal to the digest of its repository's `v<version>`
`component.json`, the tag exists and the version is unpublished; `publish --manifest` writes the descriptor from the
manifest's digests, the labelled component digests and each container repository's tag commit (`siblingCommits`; this
repository's commit is `serverCommit`), tags each image `release-<version>`, and pushes the descriptor last.

## Cutting a release

1. Each container repository is released at the version you take (`v0.1.0`), its `container-release` run green.
2. Fill `release.json` from `release.template.json`: set `version`; for each app the container release version and
   the digest of its `digest.txt` asset, e.g.
   `gh release download v0.1.0 -R pragmatic-tech-ai/<app> -p digest.txt -O -`.
3. Check it on hive: `hive.cmd run <this clone> -- npm run verify` and `-- npm test` (offline: parse and policy).
4. Commit `release.json`, push `main`: CI's `release-manifest ci` assembles it against GHCR and the container releases
   and must be green.
5. Tag that commit `release/<version>` and push the tag; `release.yml` verifies, assembles, signs and publishes.

## Registry access

The nine image packages and `pragmatic-release` were created by `pragmatic-server` and are linked to it, so this
repository's `GITHUB_TOKEN` gets 403 when `publish` tags an image or pushes the descriptor, until each of those ten
packages grants `pragmatic-platform-release` Actions access with the Write role (package settings, "Manage Actions
access"). Until then release.yml uses the optional secret `GHCR_TOKEN` (write:packages) for the publish step when set.
All ten packages are public, so reads (CI's checks, `assemble`) need no grant.

## Secrets

- `PACKAGES_TOKEN` (repository secret, read:packages): only the install steps see it, through `.npmrc`
  (`NODE_AUTH_TOKEN`).
- `RELEASE_SIGNING_KEY` (the Ed25519 private key PEM): an environment secret of the environment `release` only (no
  repository or organisation copy), so only release.yml's `publish` job, which runs in that environment, can read it.
  The environment admits only `release/*` tags, and the tag ruleset `release tags` restricts creating, updating and
  deleting `refs/tags/release/*` to the maintainers. Only `release.yml` reads the key, and `tools/tests` hold that no
  workflow of the organisation's new repositories does (from their clones beside this one, or under
  `PLATFORM_SIBLINGS_ROOT`, when present). These settings are repository security settings, kept by the maintainers,
  not by automation; a key rotation goes into the environment secret, never through a plaintext copy.
- `GHCR_TOKEN` (optional, write:packages): see Registry access.

## Development

All installs and tests run on the hive laptop (`dev-kit/tools/hive-run`): `npm ci`, `npm test`, `npm run typecheck`.
The `.npmrc` reads `NODE_AUTH_TOKEN`.
