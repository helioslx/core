import { afterEach, describe, expect, it } from "vitest";
import { SacnSource, SLOT_COUNT, ViewerService } from "../src/index.js";
import { createSacnHttpAdapter } from "../src/http.js";
import { FakeReceiver, RecordingTransport } from "../src/testing.js";

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	await Promise.allSettled(closers.splice(0).map((close) => close()));
});

const nextJsonMessage = (
	socket: WebSocket,
): Promise<Record<string, unknown>> =>
	new Promise((resolve, reject) => {
		const onMessage = (event: MessageEvent): void => {
			cleanup();
			try {
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		};
		const onError = (): void => {
			cleanup();
			reject(new Error("WebSocket connection failed."));
		};
		const cleanup = (): void => {
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("error", onError);
		};
		socket.addEventListener("message", onMessage);
		socket.addEventListener("error", onError);
	});

describe("HTTP WebSocket integration", () => {
	it("delivers viewer state and normalized packets over a real socket", async () => {
		const receiver = new FakeReceiver();
		const viewer = new ViewerService({ receiver });
		await viewer.setSelectedUniverses([1]);
		const source = new SacnSource({
			transport: new RecordingTransport(),
			createId: () => "00000000-0000-4000-8000-000000000001",
		});
		const app = createSacnHttpAdapter({ source, viewer });
		const port = 40_000 + (process.pid % 10_000);
		await new Promise<void>((resolve) => {
			app.listen({ hostname: "127.0.0.1", port }, () => {
				resolve();
			});
		});
		closers.push(
			async () => app.stop(),
			async () => viewer.close(),
			async () => source.close(),
		);
		const socket = new WebSocket(`ws://127.0.0.1:${port}/sacn/viewer/ws`);
		closers.push(async () => socket.close());
		const state = await nextJsonMessage(socket);
		expect(state.type).toBe("viewer-state");
		expect(state.viewer).toEqual({ universes: [1] });

		const packetMessage = nextJsonMessage(socket);
		receiver.emit({
			cid: "00000000-0000-4000-8000-000000000001",
			priority: 100,
			sequence: 7,
			sourceAddress: "127.0.0.1",
			sourceName: "integration",
			universe: 1,
			values: Uint8Array.of(42),
		});
		const message = await packetMessage;
		expect(message.type).toBe("viewer-packet");
		const packet = message.packet as { values: number[] };
		expect(packet.values).toHaveLength(SLOT_COUNT);
		expect(packet.values[0]).toBe(42);
	});
});
