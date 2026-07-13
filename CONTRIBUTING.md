# Contributing

Thanks for helping improve `@helioslx/core`.

Community expectations and project policy live in the
[Helios docs](https://github.com/helioslx/docs) (code of conduct, governance,
support, trademark).

## Before opening work

Use a discussion or issue for behavior changes, new public API, persistence
format changes, or substantial architecture work. For defects, include the
package version, Node/Bun version, operating system, minimal reproduction,
expected behavior, and actual behavior. Remove credentials, network addresses,
venue details, and other sensitive data.

Security vulnerabilities must be reported privately under
[SECURITY.md](SECURITY.md), not in a public issue.

## Development

Requirements:

- Node.js 22+
- npm
- optional local Redis for persistence integration work
- a safe, isolated network for UDP integration work

Install and verify:

```sh
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run build
npm pack --dry-run
```

Do not run network tests against a live lighting rig. Follow
[live-lighting safety](https://github.com/helioslx/docs/blob/main/content/docs/core/guides/safety.mdx).

## Pull requests

Keep changes focused and explain the user-visible reason for them. Add or
update tests for behavior changes and documentation/examples for public API
changes. Call out:

- breaking API or error-code changes
- lifecycle and ownership changes
- new network behavior or safety impact
- stored-data compatibility and migration requirements
- optional peer dependency changes

All checks must pass on supported Node platforms and Bun compatibility jobs.
Generated output, local environment files, credentials, and packed tarballs
must not be committed.

Contributors retain copyright in their contributions. Unless explicitly stated
otherwise, intentionally submitted contributions are provided under Apache-2.0
as described in section 5 of the license. Do not submit code or assets you do
not have the right to contribute.

## Style and compatibility

- Keep the root module runtime-neutral and free of import-time I/O.
- Keep Node, Redis, HTTP, and test integrations in explicit subpaths.
- Preserve strict TypeScript and immutable public snapshots.
- Validate all public inputs independently of transport or HTTP schemas.
- Keep bounded queues and explicit dependency ownership.
- Avoid expanding the core domain into fixtures, personalities, scenes, or
  product licensing.

Public changes follow
[versioning](https://github.com/helioslx/docs/blob/main/content/docs/core/guides/versioning.mdx).
Update [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for user-visible
changes.

## Review

Maintainers may request changes for correctness, safety, scope, API stability,
tests, documentation, licensing, or maintainability. Approval does not
guarantee immediate release.
