# Helios Core

[![npm](https://img.shields.io/npm/v/@helioslx/core)](https://www.npmjs.com/package/@helioslx/core)
[![CI](https://img.shields.io/github/actions/workflow/status/helioslx/core/ci.yml?branch=main&label=CI)](https://github.com/helioslx/core/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/codecov/c/github/helioslx/core)](https://codecov.io/gh/helioslx/core)
[![Node](https://img.shields.io/node/v/@helioslx/core)](https://nodejs.org)
[![License](https://img.shields.io/github/license/helioslx/core)](LICENSE)

`@helioslx/core` is a TypeScript toolkit for sending and observing sACN (E1.31)
from Node.js. Validated 512-slot DMX frames, sparse channel writes, fades,
optional persistence, and packet viewing — without fixture, personality, scene,
or show concepts.

> **Live-lighting warning:** Test with disconnected fixtures or a closed test
> network first. Incorrect values, universes, priorities, or interface
> selection can move equipment, trigger strobes, or black out a venue. See
> [live-lighting safety](https://docs.helioslx.com/docs/core/guides/safety)
> before connecting to a live rig.

## Requirements

- Node.js 22 or newer for the supported UDP runtime
- An IPv4 interface that can reach the sACN network
- TypeScript/ESM recommended
- Bun is compatibility-tested, but Node.js is the supported production network
  runtime

The root module is runtime-neutral. UDP, Redis, and HTTP support are isolated in
optional subpaths, so install only the peers you use.

## Quick start

```sh
npm install @helioslx/core sacn
```

```ts
import { createSacnSource } from "@helioslx/core/node";

const source = createSacnSource({
  name: "My lighting app",
  transportOptions: {
    // Set iface when the host has more than one network interface.
    iface: "192.168.10.20",
  },
});

const universe = source.universe(1, {
  priority: 100,
  sourceName: "Dimmers",
});

await universe.fadeChannels(
  {
    1: 255,
    2: 128,
  },
  { durationMs: 1_000 },
);

// Node sources install SIGINT/SIGTERM/beforeExit handlers that call close().
```

Public channels are one-based (`1..512`); values are integers from `0..255`.
Universes are `1..63999`, priorities are `0..200`, and priority defaults to
`100`. A full frame must contain exactly 512 values.

Mutations auto-start the scheduler. Reads (`get`, `listUniverses`) do not.
Awaiting a mutation means the write is scheduled and persisted, not that a fade
has finished.

See the complete [quick-start example](examples/quickstart.ts).

## Common operations

Snap channels immediately:

```ts
await universe.setChannels({ 1: 255, 2: 128 });
```

Fade several channels with one shared duration:

```ts
await universe.fadeChannels({ 1: 0, 2: 0 }, { durationMs: 1_000 });
```

Per-channel durations:

```ts
await universe.transition([
  { channel: 1, value: 0, durationMs: 500 },
  { channel: 10, value: 255, durationMs: 2_000 },
]);
```

Write a complete frame:

```ts
const frame = new Uint8Array(512);
frame[0] = 255;
frame[1] = 128;
await universe.write(frame, { durationMs: 2_000 });
```

Later writes win for channels already fading. Unmentioned channels retain their
current transitions and targets.

Inspect and clear output:

```ts
const output = await universe.get();
const outputs = await source.listUniverses();
const removed = await universe.clear();
```

## Optional adapters

| Import | Peer dependency | Purpose |
| --- | --- | --- |
| `@helioslx/core/node` | `sacn` | Node UDP sender, receiver, process handlers, and runtime telemetry |
| `@helioslx/core/redis` | `redis` | Versioned output and viewer persistence |
| `@helioslx/core/http` | `elysia`, `@elysiajs/node`, `@elysiajs/openapi` | Unbound REST, OpenAPI, and viewer WebSocket routes |
| `@helioslx/core/testing` | none | Fake clock/receiver and recording transport |

The HTTP adapter does not bind a port, configure CORS, rate limit requests, or
choose an authentication policy. The host application owns those decisions.

## Lifecycle and ownership

1. Construct a source (and optional universe handles).
2. Mutate output — the first output-demanding op restores state and starts
   scheduling — or call `start()` explicitly.
3. Await mutations; they are ordered with persistence.
4. Call `stop()` to pause the scheduler while keeping state, or `close()` for
   final teardown. Repeated `close()` calls are safe.

Root sources and viewers do not close injected transports, receivers, or stores
by default. Set the corresponding ownership option when transferring ownership.
`createSacnSource` from `@helioslx/core/node` creates and owns its transport and
registers for process-signal teardown (opt out with
`installProcessHandlers: false`). Default memory stores and internally-created
Redis clients are also owned.

Universe mutators accept `signal`. A timed-out send remains serialized until
the underlying transport promise settles, preventing overlapping sends even
when a transport ignores cancellation. Source transport shutdown is bounded by
`shutdownTimeoutMs` (2 seconds by default).

## Documentation

Guides, API reference, examples, and community policies:
[docs.helioslx.com](https://docs.helioslx.com/docs/core).

Runnable samples also live in [`examples/`](examples/).

## License

Apache-2.0. See [LICENSE](LICENSE).
