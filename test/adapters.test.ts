import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  DependencyUnavailableError,
  SacnSource,
  SLOT_COUNT,
  ViewerService,
  type OutputPacket,
  type ReceiverPacket,
} from "../src/index.js";
import {
  NodeSacnReceiver,
  NodeSacnTransport,
  createSacnSource,
  flushActiveSacnSourcesForTests,
  type NodeReceiverInstance,
  type NodeSender,
} from "../src/node.js";
import {
  RedisOutputStore,
  RedisViewerStore,
  type RedisClientCompatible,
} from "../src/redis.js";
import { createSacnHttpAdapter } from "../src/http.js";
import {
  FakeClock,
  FakeReceiver,
  RecordingTransport,
  createDeferred,
} from "../src/testing.js";

const CID = "00000000-0000-4000-8000-000000000001";

const packet = (overrides: Partial<OutputPacket> = {}): OutputPacket => ({
  cid: CID,
  universe: 1,
  priority: 100,
  sequence: 0,
  sourceName: null,
  data: new Uint8Array(SLOT_COUNT),
  ...overrides,
});

describe("Node adapters", () => {
  it("registers Node sources for process teardown without installing handlers when opted out", async () => {
    await flushActiveSacnSourcesForTests();
    const source = createSacnSource({
      name: "test-source",
      installProcessHandlers: false,
      createId: () => CID,
      transportOptions: {
        senderFactory: () => ({
          send: async () => undefined,
          close: () => undefined,
        }),
      },
    });
    await source.universe(1).setChannels({ 1: 1 });
    expect(source.getTelemetry().running).toBe(true);
    await flushActiveSacnSourcesForTests();
    await expect(source.listUniverses()).rejects.toMatchObject({
      code: "INVALID_LIFECYCLE",
    });
  });

  it("reuses, isolates, closes, and recreates output senders", async () => {
    const senders: Array<
      NodeSender & { close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }
    > = [];
    const transport = new NodeSacnTransport({
      sourceName: "Helios",
      senderFactory: () => {
        const sender = {
          send: vi.fn(async () => undefined),
          close: vi.fn(),
        };
        senders.push(sender);
        return sender;
      },
    });
    const signal = new AbortController().signal;

    await transport.send(packet(), signal);
    await transport.send(packet({ sequence: 1 }), signal);
    expect(senders).toHaveLength(1);
    expect(senders[0]?.send).toHaveBeenCalledTimes(2);
    const wirePayload = senders[0]?.send.mock.calls[0]?.[0].payload;
    expect(Object.keys(wirePayload ?? {})).toHaveLength(SLOT_COUNT);
    expect(wirePayload?.[1]).toBe(0);
    expect(wirePayload?.[512]).toBe(0);
    expect(wirePayload?.[0]).toBeUndefined();

    await transport.send(packet({ priority: 101 }), signal);
    expect(senders).toHaveLength(2);

    await transport.send(
      packet({ cid: "00000000-0000-4000-8000-000000000002" }),
      signal,
    );
    expect(senders).toHaveLength(3);
    expect(senders[0]?.close).toHaveBeenCalledOnce();

    await transport.closeOutput({ universe: 1, priority: 101 });
    expect(senders[1]?.close).toHaveBeenCalledOnce();
    await transport.close();
    expect(senders[2]?.close).toHaveBeenCalledOnce();
  });

  it("normalizes receiver packets to the public contract", async () => {
    let packetListener: ((packet: never) => void) | undefined;
    const instance: NodeReceiverInstance = {
      addUniverse: vi.fn(),
      removeUniverse: vi.fn(),
      on: (event, listener) => {
        if (event === "packet") {
          packetListener = listener as (packet: never) => void;
        }
      },
      off: vi.fn(),
      close: (callback) => callback?.(),
    };
    const receiver = new NodeSacnReceiver({
      receiverFactory: () => instance,
    });
    const received: ReceiverPacket[] = [];
    receiver.subscribe((value) => received.push(value));
    packetListener?.({
      universe: 2,
      priority: 99,
      sequence: 8,
      cid: Buffer.from(CID.replaceAll("-", ""), "hex"),
      sourceName: "desk",
      sourceAddress: "10.0.0.2",
      payload: { 1: 255, 512: 7 },
    } as never);

    expect(received[0]?.values).toHaveLength(SLOT_COUNT);
    expect(received[0]?.values[0]).toBe(255);
    expect(received[0]?.values[511]).toBe(7);
    expect(received[0]?.cid).toBe(CID);
    await receiver.close();
    expect(instance.off).toHaveBeenCalled();
  });

  it("rejects universe changes when receiver startup fails", async () => {
    const startupError = new Error("bind failed");
    const instance: NodeReceiverInstance = {
      addUniverse: vi.fn(),
      removeUniverse: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      close: (callback) => callback?.(),
      ready: Promise.reject(startupError),
    };
    const receiver = new NodeSacnReceiver({
      receiverFactory: () => instance,
    });
    await expect(receiver.addUniverse(1)).rejects.toBe(startupError);
    expect(instance.addUniverse).not.toHaveBeenCalled();
    await receiver.close();
  });
});

describe("Viewer service", () => {
  it("normalizes packets, isolates listeners, and coalesces bounded streams", async () => {
    const receiver = new FakeReceiver();
    const warnings: unknown[] = [];
    const viewer = new ViewerService({
      receiver,
      clock: { now: () => 42 },
      logger: { warn: (_message, context) => warnings.push(context) },
      streamCapacity: 2,
    });
    await viewer.setSelectedUniverses([2, 1, 1]);
    expect(viewer.getSelectedUniverses()).toEqual([1, 2]);
    viewer.subscribe(() => {
      throw new Error("listener failed");
    });
    const observed: number[] = [];
    viewer.subscribe((value) => observed.push(value.values[0] ?? 0));
    const stream = viewer.packets();

    const emit = (universe: number, first: number): void =>
      receiver.emit({
        universe,
        priority: 100,
        sequence: first,
        cid: CID,
        sourceName: "source",
        sourceAddress: null,
        values: Uint8Array.of(first),
      });
    emit(1, 1);
    emit(1, 2);
    emit(2, 3);

    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    expect(first.value?.values).toHaveLength(SLOT_COUNT);
    expect(first.value?.values[0]).toBe(2);
    expect(second.value?.universe).toBe(2);
    expect(observed).toEqual([1, 2, 3]);
    expect(warnings).toHaveLength(3);
    expect(viewer.getTelemetry().droppedUpdates).toBe(1);
    const concurrentStream = viewer.packets();
    const concurrentIterator = concurrentStream[Symbol.asyncIterator]();
    const pendingFirst = concurrentIterator.next();
    const pendingSecond = concurrentIterator.next();
    emit(1, 4);
    emit(2, 5);
    expect((await pendingFirst).value?.values[0]).toBe(4);
    expect((await pendingSecond).value?.values[0]).toBe(5);
    concurrentStream.close();
    const viewerSource = new SacnSource({
      transport: new RecordingTransport(),
      createId: () => CID,
    });
    const http = createSacnHttpAdapter({
      source: viewerSource,
      viewer,
    });
    expect(
      http.routes.some(
        (route) => route.method === "WS" && route.path.endsWith("/viewer/ws"),
      ),
    ).toBe(true);
    stream.close();
    await viewer.close();
    await viewerSource.close();
  });
});

class FakeRedisClient implements RedisClientCompatible {
  readonly values = new Map<string, string>();
  quitCalls = 0;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async *scanIterator(options: {
    MATCH: string;
  }): AsyncIterable<string> {
    const pattern = options.MATCH;
    const prefix = pattern.slice(0, -1);
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) yield key;
    }
  }

  async quit(): Promise<void> {
    this.quitCalls += 1;
  }
}

describe("Redis adapters", () => {
  it("uses namespaced records, validates data, and honors client ownership", async () => {
    const client = new FakeRedisClient();
    const outputs = new RedisOutputStore({
      client,
      namespace: "test",
      version: 3,
    });
    await outputs.save({
      universe: 2,
      priority: 100,
      cid: CID,
      idleFps: 2,
      sourceName: null,
      target: Array.from({ length: SLOT_COUNT }, () => 0),
      updatedAt: 1,
    });
    expect(client.values.has("test:v3:output:2:100")).toBe(true);
    expect((await outputs.list())[0]?.universe).toBe(2);
    await outputs.close();
    expect(client.quitCalls).toBe(0);
    await expect(outputs.list()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });

    const viewers = new RedisViewerStore({ client, closeClient: true });
    await viewers.save({ selectedUniverses: [2, 1, 2], updatedAt: 4 });
    expect((await viewers.load())?.selectedUniverses).toEqual([1, 2]);
    await viewers.close();
    expect(client.quitCalls).toBe(1);

    const corrupt = new RedisOutputStore({ client, namespace: "corrupt" });
    client.values.set("corrupt:v1:output:3:100", '{"universe":3}');
    await expect(corrupt.list()).rejects.toMatchObject({
      code: "PERSISTENCE_ERROR",
    });
    await corrupt.close();
  });
});

describe("HTTP and package exports", () => {
  it("serves canonical and deprecated Elysia routes without binding", async () => {
    const source = new SacnSource({
      transport: new RecordingTransport(),
      clock: new FakeClock(),
      createId: () => CID,
    });
    const app = createSacnHttpAdapter({ source });
    expect(
      app.routes.some(
        (route) =>
          route.method === "GET" &&
          route.path.endsWith("/openapi/json"),
      ),
    ).toBe(true);
    expect(
      (
        await app.handle(
          new Request("http://localhost/sacn/health/live"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.handle(
          new Request("http://localhost/sacn/health/ready"),
        )
      ).status,
    ).toBe(503);
    const frame = Array.from({ length: SLOT_COUNT }, () => 0);
    frame[0] = 123;
    const write = await app.handle(
      new Request("http://localhost/sacn/universes/1/priorities/100/frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: frame }),
      }),
    );
    expect(write.status).toBe(200);

    const fetched = await app.handle(
      new Request("http://localhost/sacn/universes/1/priorities/100"),
    );
    expect((await fetched.json()).current[0]).toBe(123);

    const missing = await app.handle(
      new Request("http://localhost/sacn/universes/9/priorities/100"),
    );
    expect(missing.status).toBe(404);

    const legacy = await app.handle(
      new Request("http://localhost/sacn/outputs"),
    );
    expect(legacy.headers.get("deprecation")).toBe("true");
    expect(legacy.headers.get("link")).toContain("/sacn/universes");
    expect(legacy.headers.get("sunset")).toBeTruthy();

    const invalid = await app.handle(
      new Request("http://localhost/sacn/universes/1/priorities/100/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channels: [{ channel: 0, value: 1 }] }),
      }),
    );
    expect(invalid.status).toBe(400);
    const invalidSource = await app.handle(
      new Request("http://localhost/sacn/universes/1/priorities/100/frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: frame, sourceName: 123 }),
      }),
    );
    expect(invalidSource.status).toBe(400);

    const specification = await app.handle(
      new Request("http://localhost/sacn/openapi/json"),
    );
    expect(specification.status).toBe(200);
    const openapi = (await specification.json()) as any;
    expect(openapi.components.schemas.OutputSnapshot).toBeTruthy();
    expect(
      openapi.paths[
        "/sacn/universes/{universe}/priorities/{priority}/frame"
      ].post.requestBody,
    ).toBeTruthy();
    expect(
      openapi.paths[
        "/sacn/universes/{universe}/priorities/{priority}/frame"
      ].post.responses["200"].content["application/json"].schema.$ref,
    ).toBe("#/components/schemas/OutputSnapshot");

    const unavailable = createSacnHttpAdapter({
      source,
      auth: () => {
        throw new DependencyUnavailableError("Auth provider unavailable.");
      },
    });
    expect(
      (
        await unavailable.handle(
          new Request("http://localhost/sacn/universes"),
        )
      ).status,
    ).toBe(503);

    await source.close();
    expect(
      (
        await app.handle(new Request("http://localhost/sacn/universes"))
      ).status,
    ).toBe(409);
  });

  it("declares every independently built public subpath", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(Object.keys(manifest.exports)).toEqual([
      ".",
      "./node",
      "./redis",
      "./http",
      "./testing",
    ]);
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.peerDependenciesMeta.sacn.optional).toBe(true);
  });
});

describe("Core cancellation and transport serialization", () => {
  it("does not overlap a replacement send while a timed-out send is unsettled", async () => {
    const clock = new FakeClock();
    const transport = new RecordingTransport();
    const pending = createDeferred<void>();
    transport.sendImplementation = async () => pending.promise;
    const source = new SacnSource({
      transport,
      clock,
      createId: () => CID,
      sendTimeoutMs: 10,
    });
    await source.universe(1).setChannels({ 1: 1 });
    await source.start();
    await vi.waitFor(() => expect(transport.packets).toHaveLength(1));
    clock.advanceBy(10);
    await vi.waitFor(() =>
      expect(source.getTelemetry().transport.sendTimeouts).toBe(1),
    );
    clock.advanceBy(1000);
    await Promise.resolve();
    expect(transport.packets).toHaveLength(1);

    pending.resolve();
    await vi.waitFor(() => expect(transport.packets.length).toBeGreaterThan(1));
    await source.close();
  });

  it("rejects an aborted queued mutation before changing output state", async () => {
    const loading = createDeferred<readonly never[]>();
    const source = new SacnSource({
      transport: new RecordingTransport(),
      createId: () => CID,
      store: {
        list: async () => loading.promise,
        get: async () => null,
        save: async () => undefined,
        remove: async () => undefined,
      },
    });
    const starting = source.start();
    const abort = new AbortController();
    const mutation = source.universe(1).setChannels({ 1: 1 }, { signal: abort.signal });
    abort.abort(new Error("cancelled"));
    loading.resolve([]);
    await starting;
    await expect(mutation).rejects.toThrow("cancelled");
    expect(await source.listUniverses()).toHaveLength(0);
    await source.close();
  });
});
