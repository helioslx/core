# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/), with the
pre-1.0 policy described in
[versioning](https://docs.helioslx.com/docs/core/guides/versioning).

## 0.2.0 - 2026-07-13

### Changed

- Renamed the public output facade from `SacnController` to `SacnSource` with
  cached `Universe` handles (`setChannels` maps, `fadeChannels`, `transition`,
  `write`).
- Split lifecycle into `start` / `stop` (pause) / `close` (teardown), with
  implicit start on output mutations and optional `onStart` / `onStop` /
  `onClose` hooks.
- Node `createSacnSource` replaces `createNodeSacnController` and registers
  sources for one-time `SIGINT` / `SIGTERM` / `beforeExit` auto-close.
- HTTP adapter now takes `source` and uses `durationMs` (maps or channel arrays).

### Added

- Comprehensive public API, architecture, networking, safety, persistence, and
  release documentation.
- Runnable TypeScript examples for output, viewing, Redis, HTTP, and shutdown.
- Open-source governance, contribution, security, conduct, support, and
  trademark policies.
- Node/macOS, Node/Linux, Bun, dependency review, and provenance release
  automation.

## 0.1.0 - 2026-07-12

### Added

- Runtime-neutral controller contracts, validated full-frame and sparse channel
  writes, linear fades, scheduling, cancellation, persistence, and telemetry.
- Node sACN sender and receiver adapters.
- Memory and Redis output/viewer stores.
- Viewer callbacks and bounded/coalescing async streams.
- Embedded Elysia REST, OpenAPI, and WebSocket adapter.
- Deterministic testing utilities.
