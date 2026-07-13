import { afterEach, describe, expect, it } from "vitest";
import { SLOT_COUNT, type ReceiverPacket } from "../src/index.js";
import { NodeSacnReceiver, NodeSacnTransport } from "../src/node.js";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(resources.splice(0).map((resource) => resource.close()));
});

describe("Node UDP integration", () => {
  it("sends and receives a normalized 512-slot frame over loopback", async () => {
    const port = 20_000 + (process.pid % 20_000);
    const universe = 63_990;
    let rejectReceiverError: ((error: Error) => void) | undefined;
    const receiverError = new Promise<never>((_resolve, reject) => {
      rejectReceiverError = reject;
    });
    const receiver = new NodeSacnReceiver({
      iface: "127.0.0.1",
      port,
      universes: [universe],
      logger: {
        error: (_message, context) => {
          rejectReceiverError?.(
            context?.error instanceof Error
              ? context.error
              : new Error("Receiver failed."),
          );
        },
      },
    });
    const transport = new NodeSacnTransport({
      iface: "127.0.0.1",
      port,
      sourceName: "helios-loopback-test",
      unicastDestination: "127.0.0.1",
    });
    resources.push(receiver, transport);

    const received = new Promise<ReceiverPacket>((resolve) => {
      receiver.subscribe(resolve);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const data = new Uint8Array(SLOT_COUNT);
    data[0] = 201;
    data[511] = 9;
    await transport.send(
      {
        cid: "00000000-0000-4000-8000-000000000001",
        data,
        priority: 0,
        sequence: 77,
        sourceName: "integration",
        universe,
      },
      new AbortController().signal,
    );

    const packet = await Promise.race([
      received,
      receiverError,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for UDP frame.")), 1500);
      }),
    ]);
    expect(packet.universe).toBe(universe);
    expect(packet.priority).toBe(0);
    expect(packet.sequence).toBe(77);
    expect(packet.values).toHaveLength(SLOT_COUNT);
    expect(packet.values[0]).toBe(201);
    expect(packet.values[511]).toBe(9);
  });
});
