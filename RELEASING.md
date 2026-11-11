# Releasing Deckard

A Deckard release is one Arthur Engine release, published under Deckard's name with the
chart and Compose setup that run it. Merging a new version to `main` releases it.

## What a release publishes

| | |
|---|---|
| Image | `arthurplatform/deckard:<version>` and `:latest`: the engine release's `arthurplatform/ml-engine` image, copied unchanged (same digest, every architecture, SBOM included) |
| Chart | `oci://ghcr.io/arthur-ai/charts/deckard`, version `<version>` |
| Tag | `v<version>`, with a GitHub release naming the engine release and listing the merged PRs |

## Where the versions live

[`charts/deckard/Chart.yaml`](charts/deckard/Chart.yaml) holds Deckard's version (`version`
and `appVersion`, always equal) and the engine release it pins (`arthur.ai/engine-version`
and `arthur.ai/engine-digest`). The Compose file's image tag, the collector `scan-local.sh`
runs and the Windows query `scan-local.ps1` runs follow them.

Change them with `scripts/bump.sh`, not by hand. CI checks that every file agrees
(`scripts/versions.sh`) and that the pins are the engine release they name, then runs the
quickstart end to end on that engine image.

## Moving to a new engine release

The [Engine bump](.github/workflows/engine-bump.yaml) workflow checks daily for a new Arthur
Engine release and keeps one PR open that moves Deckard to it as the next patch version.

- **Merge it** to release that version.
- **Close it** to skip that engine release, for example when nothing in it touches
  discovery. The next engine release opens a new PR.

For a minor version instead, run `scripts/bump.sh --deckard 0.2.0` on the PR's branch. To
move to a particular engine release, run the workflow by hand and name it.

## Releasing without a new engine

For a change to the chart, the Compose setup or the docs that users should get as a release,
run `scripts/bump.sh --deckard <next version>` and merge it with the change or after it.

## If a release fails

The [Release](.github/workflows/release.yaml) workflow runs on every push to `main` and
does nothing unless `Chart.yaml`'s version is untagged. It publishes the image, then the
chart, and tags last, so rerunning it on `main` finishes a release that failed partway. A
published image version never changes: a rerun that would publish a different image under
it fails.

## One-time setup

- **Docker Hub:** a public repository, `arthurplatform/deckard`, and this repository's
  secrets `DOCKERHUB_OSS_USERNAME` and `DOCKERHUB_OSS_TOKEN` for an account that can push to
  it, as the engine publishes with.
- **GHCR:** after the first release, make the `charts/deckard` package public in its
  settings. New packages start private.
