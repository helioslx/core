import { describe, expect, it, vi } from "vitest";
import {
	SacnLifecycleError,
	SacnSource,
	SLOT_COUNT,
	ViewerService,
} from "../src/index.js";
import {
	FakeClock,
	FakeReceiver,
	RecordingTransport,
} from "../src/testing.js";

const CID = "00000000-0000-4000-8000-000000000001";

const createSource = (
	options: Partial<ConstructorParameters<typeof SacnSource>[0]> = {},
) =>
	new SacnSource({
		transport: new RecordingTransport(),
		ownsTransport: true,
		createId: () => CID,
		...options,
	});

describe("core reliability limits", () => {
	it("enforces the configured output limit before creating state", async () => {
		const source = createSource({ maxOutputs: 1 });
		await source.universe(1).setChannels({ 1: 1 });

		await expect(source.universe(2).setChannels({ 1: 2 })).rejects.toBeInstanceOf(
			SacnLifecycleError,
		);
		expect(await source.listUniverses()).toHaveLength(1);
		await source.close();
	});

	it("starts an overriding fade from the interpolated live value", async () => {
		const clock = new FakeClock();
		const source = createSource({ clock });
		await source.universe(1).fadeChannels({ 1: 200 }, { durationMs: 1000 });
		clock.advanceBy(250);
		await source.universe(1).fadeChannels({ 1: 100 }, { durationMs: 500 });
		clock.advanceBy(250);

		expect((await source.universe(1).get())?.current[0]).toBe(75);
		await source.close();
	});

	it("bounds shutdown when a transport close never settles", async () => {
		vi.useFakeTimers();
		const transport = new RecordingTransport();
		transport.close = async () => await new Promise<void>(() => undefined);
		let storeCloses = 0;
		const source = createSource({
			transport,
			shutdownTimeoutMs: 10,
			ownsStore: true,
			store: {
				get: async () => null,
				list: async () => [],
				save: async () => undefined,
				remove: async () => undefined,
				close: async () => {
					storeCloses += 1;
				},
			},
		});
		const closing = source.close();
		await vi.advanceTimersByTimeAsync(10);
		await expect(closing).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
		expect(storeCloses).toBe(1);
		vi.useRealTimers();
	});

	it("can leave caller-owned transport and store resources open", async () => {
		const transport = new RecordingTransport();
		let storeCloses = 0;
		const source = new SacnSource({
			transport,
			createId: () => CID,
			store: {
				get: async () => null,
				list: async () => [],
				save: async () => undefined,
				remove: async () => undefined,
				close: async () => {
					storeCloses += 1;
				},
			},
		});
		await source.close();
		expect(transport.closeCalls).toBe(0);
		expect(storeCloses).toBe(0);
	});

	it("rejects subscribers above the configured viewer limit", async () => {
		const receiver = new FakeReceiver();
		const viewer = new ViewerService({
			receiver,
			maxListeners: 1,
		});
		const unsubscribe = viewer.subscribe(() => undefined);
		expect(() => viewer.packets()).toThrow(SacnLifecycleError);
		unsubscribe();
		const stream = viewer.packets();
		stream.close();
		await viewer.close();
		expect(receiver.closed).toBe(false);
	});

	it("rolls back viewer membership when persistence fails", async () => {
		const receiver = new FakeReceiver();
		const viewer = new ViewerService({
			receiver,
			store: {
				load: async () => null,
				save: async () => {
					throw new Error("store unavailable");
				},
			},
		});
		await expect(viewer.setSelectedUniverses([1, 2])).rejects.toMatchObject({
			code: "PERSISTENCE_ERROR",
		});
		expect(viewer.getSelectedUniverses()).toEqual([]);
		expect([...receiver.universes]).toEqual([]);
		await viewer.close();
	});

	it("rolls back output mutations before they can transmit when storage fails", async () => {
		const transport = new RecordingTransport();
		let failWrites = true;
		const source = createSource({
			transport,
			store: {
				get: async () => null,
				list: async () => [],
				save: async () => {
					if (failWrites) throw new Error("store unavailable");
				},
				remove: async () => undefined,
			},
		});
		await source.start();
		await expect(source.universe(1).setChannels({ 1: 255 })).rejects.toMatchObject({
			code: "PERSISTENCE_ERROR",
		});
		expect(await source.listUniverses()).toEqual([]);
		expect(transport.packets).toEqual([]);

		failWrites = false;
		await source.universe(1).setChannels({ 1: 10 });
		await vi.waitFor(() => expect(transport.packets).toHaveLength(1));
		failWrites = true;
		await expect(source.universe(1).setChannels({ 1: 200 })).rejects.toMatchObject({
			code: "PERSISTENCE_ERROR",
		});
		expect((await source.universe(1).get())?.target[0]).toBe(10);
		await source.close();
	});

	it("does not blackout or remove a live output when durable removal fails", async () => {
		const transport = new RecordingTransport();
		let failRemoval = false;
		const source = createSource({
			transport,
			store: {
				get: async () => null,
				list: async () => [],
				save: async () => undefined,
				remove: async () => {
					if (failRemoval) throw new Error("store unavailable");
				},
			},
		});
		await source.universe(1).setChannels({ 1: 255 });
		failRemoval = true;
		const packetsBeforeClear = transport.packets.length;
		await expect(source.universe(1).clear()).rejects.toMatchObject({
			code: "PERSISTENCE_ERROR",
		});
		expect((await source.universe(1).get())?.target[0]).toBe(255);
		expect(transport.packets).toHaveLength(packetsBeforeClear);
		await source.close();
	});

	it("rolls back partially restored outputs when startup validation fails", async () => {
		let records: readonly any[] = [
			{
				universe: 1,
				priority: 100,
				cid: CID,
				idleFps: 2,
				sourceName: null,
				target: Array.from({ length: SLOT_COUNT }, () => 0),
				updatedAt: Date.now(),
			},
			{
				universe: 2,
				priority: 100,
				cid: "invalid",
				idleFps: 2,
				sourceName: null,
				target: Array.from({ length: SLOT_COUNT }, () => 0),
				updatedAt: Date.now(),
			},
		];
		const source = createSource({
			store: {
				get: async () => null,
				list: async () => records,
				save: async () => undefined,
				remove: async () => undefined,
			},
		});
		await expect(source.start()).rejects.toBeTruthy();
		expect(await source.listUniverses()).toEqual([]);
		records = [];
		await expect(source.start()).resolves.toBeUndefined();
		await source.close();
	});

	it("accepts and detaches a complete Uint8Array frame", async () => {
		const source = createSource();
		const frame = new Uint8Array(SLOT_COUNT);
		frame[0] = 255;
		const snapshot = await source.universe(1).write(frame);
		frame[0] = 0;
		expect(snapshot.current[0]).toBe(255);
		expect((await source.universe(1).get())?.current[0]).toBe(255);
		await source.close();
	});

	it("returns typed validation errors for malformed JavaScript inputs", async () => {
		const source = createSource();
		await expect(
			source.universe(1).write(null as never),
		).rejects.toMatchObject({ code: "INVALID_FRAME" });
		await expect(
			source.universe(1).setChannels(null as never),
		).rejects.toMatchObject({ code: "INVALID_CHANNEL" });
		await expect(
			source.universe(1).transition([null as never]),
		).rejects.toMatchObject({ code: "INVALID_CHANNEL" });
		expect(() => source.universe(Number.NaN)).toThrow(
			expect.objectContaining({ code: "INVALID_UNIVERSE" }),
		);
		await source.close();
	});

	it("publishes lifecycle and output events while isolating listeners", async () => {
		const warnings: unknown[] = [];
		const source = createSource({
			logger: { warn: (_message, context) => warnings.push(context) },
		});
		const eventTypes: string[] = [];
		source.subscribe(() => {
			throw new Error("listener failure");
		});
		source.subscribe((event) => eventTypes.push(event.type));
		await source.start();
		await source.universe(1).setChannels({ 1: 1 });
		await source.universe(1).clear();
		await source.close();

		expect(eventTypes).toEqual([
			"started",
			"output-updated",
			"output-cleared",
			"closed",
		]);
		expect(warnings).toHaveLength(4);
	});

	it("retries failed sends with retry telemetry", async () => {
		const clock = new FakeClock();
		const transport = new RecordingTransport();
		let attempts = 0;
		transport.sendImplementation = async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("network unavailable");
		};
		const source = createSource({ clock, transport });
		await source.universe(1).setChannels({ 1: 1 });
		await source.start();
		await vi.waitFor(() =>
			expect(source.getTelemetry().transport.sendFailures).toBe(1),
		);
		clock.advanceBy(100);
		await vi.waitFor(() =>
			expect(source.getTelemetry().transport.sendSuccesses).toBe(1),
		);
		expect(source.getTelemetry().transport.sendRetries).toBe(1);
		await source.close();
	});

	it("wraps the public and transport sequence after 255", async () => {
		const transport = new RecordingTransport();
		const source = createSource({ transport });
		await source.universe(1).setChannels({ 1: 0 });
		await source.start();
		await vi.waitFor(() => expect(transport.packets).toHaveLength(1));

		for (let index = 1; index <= 256; index += 1) {
			await source.universe(1).setChannels({ 1: index % 2 });
			await vi.waitFor(
				() => expect(transport.packets).toHaveLength(index + 1),
				{ interval: 1, timeout: 100 },
			);
		}

		expect(transport.packets[255]?.sequence).toBe(255);
		expect(transport.packets[256]?.sequence).toBe(0);
		await vi.waitFor(() =>
			expect(source.getTelemetry().transport.sendSuccesses).toBe(257),
		);
		expect((await source.universe(1).get())?.sequence).toBe(1);
		await source.close();
	});
});
