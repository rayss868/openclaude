# Release Documentation and Changelog Design

**Date:** 2026-08-20
**Status:** Approved for implementation planning

## Goal

Make release changes discoverable from the README while keeping one consistent release workflow for the repository, GitHub Releases, and npm. Future releases use the upstream semantic version without the `-by-rayss` suffix.

## Current context

- `CHANGELOG.md` already contains versioned release notes with compare links and categorized entries.
- `README.md` already links to GitHub tags and the npm package, but does not provide direct changelog or GitHub Releases links.
- `.github/workflows/release.yml` already uses Release Please on pushes to `main`.
- When a release is created, the workflow verifies installation, builds and tests the release tag, publishes to npm with provenance, verifies the npm `latest` tag, and builds the container image.
- Repository guidance says release notes should live on GitHub Releases rather than in a manually maintained website data source.

## Design

### README entry points

Add direct links to both release-note sources in the README's early navigation area:

- `Changelog` → the repository's `CHANGELOG.md`.
- `Releases` → the GitHub Releases page.

Add a short release-notes paragraph near Quick Start explaining that:

- the complete version history is in `CHANGELOG.md`;
- published release notes and release assets are available on GitHub Releases; and
- the npm package's `latest` version is the published stable release.

The README remains an entry point, not a second manually maintained changelog. Do not duplicate full release notes there.

### Changelog ownership and format

Keep `CHANGELOG.md` as the repository-local version history. Continue using the existing format:

- version heading with a GitHub compare link;
- release date;
- categorized entries such as `Features`, `Bug Fixes`, and `Performance Improvements`.

Release Please remains responsible for updating the changelog for future releases. Manual README summaries and a second release-notes data source are out of scope.

### Version policy

Use the upstream version format for the next release cycle:

- package version: `X.Y.Z`;
- Git tag: `vX.Y.Z`;
- GitHub Release: `X.Y.Z` / `vX.Y.Z` according to Release Please output;
- npm version and `latest` dist-tag: `X.Y.Z`.

The already-published custom package `0.29.1-by-rayss` is historical and is not rewritten. The documentation change must not attempt to republish or rename that version.

### Release flow

1. Contributors merge Conventional Commit messages into `main`.
2. Release Please analyzes commits and maintains the release PR.
3. When the release PR is merged, Release Please updates the version metadata and `CHANGELOG.md`, creates the version tag, and creates the GitHub Release.
4. The release workflow checks out the release tag and runs dependency installation, build, install-hygiene verification, unit tests, and the smoke test.
5. The publish job uses npm trusted publishing with public access and provenance.
6. The workflow verifies that npm's package version, `latest` dist-tag, and `@latest` resolution all match the Release Please version.
7. The workflow summary links to both the npm package and the GitHub Release.

No new publish workflow is needed. The implementation should preserve the existing release gates and only improve discoverability/documentation.

## Scope

### In scope

- README navigation links to `CHANGELOG.md` and GitHub Releases.
- A concise README explanation of where release changes are documented.
- Documentation wording that describes the upstream version policy and automated release path.
- Link and documentation validation.

### Out of scope

- Rewriting the historical `0.29.1-by-rayss` npm release.
- Adding a manually maintained release-notes feed to the website.
- Replacing Release Please.
- Changing npm authentication, trusted publishing, test gates, Docker publishing, or workflow permissions.
- Adding new runtime or application features.

## Validation

- Confirm README links resolve to the repository changelog and GitHub Releases page.
- Confirm the README does not duplicate full changelog entries.
- Run the narrowest available documentation/repository checks, followed by `bun run check` if practical.
- Confirm `.github/workflows/release.yml` is unchanged unless a documentation-only adjustment is required by the implementation.
- Confirm no unresolved merge conflicts or unrelated files are included in the implementation change.

## Acceptance criteria

- A new contributor can find the full changelog and GitHub Releases from the README without searching the repository.
- Future release notes continue to be generated and published by Release Please and remain visible in both `CHANGELOG.md` and GitHub Releases.
- Future versions use upstream semantic versions without the `-by-rayss` suffix.
- The existing automated npm publish and verification flow remains intact.
