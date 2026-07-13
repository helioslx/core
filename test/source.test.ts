import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MemoryOutputStore,
	SacnLifecycleError,
	SacnSource,
	SacnValidationError,
	SLOT_COUNT,
	type Clock,
	type OutputPacket,
	type OutputTransport,
} from "../src/index.js";

const TEST_CID = "00000000-0000-4000-8000-000000000001";

class ManualClock implements Clock {
	time = 0;

	now(): number {
		return this.time;
	}

	sleep(_delayMs: number, signal: AbortSignal): Promise<void> {
		return new Promise((_resolve, reject) => {
			signal.addEventListener(
				"abort",
				() => {
					reject(signal.reason);
				},
				{ once: true },
			);
		});
	}
}

class RecordingTransport implements OutputTransport {
	readonly packets: OutputPacket[] = [];
	readonly closedOutputs: { universe: number; priority: number }[] = [];
	closed = false;
	sendImplementation?: (
		packet: OutputPacket,
		signal: AbortSignal,
	) => Promise<void>;

	async send(packet: OutputPacket, signal: AbortSignal): Promise<void> {
		this.packets.push({ ...packet, data: packet.data.slice() });
		await this.sendImplementation?.(packet, signal);
	}

	async closeOutput(address: {
		universe: number;
		priority: number;
	}): Promise<void> {
		this.closedOutputs.push(address);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

const sources = new Set<SacnSource>();

const createSource = (
	transport = new RecordingTransport(),
	options: Partial<ConstructorParameters<typeof SacnSource>[0]> = {},
): { source: SacnSource; transport: RecordingTransport } => {
	const source = new SacnSource({
		transport,
		ownsTransport: true,
		createId: () => TEST_CID,
		...options,
	});
	sources.add(source);
	return { source, transport };
};

afterEach(async () => {
	await Promise.allSettled([...sources].map((source) => source.close()));
	sources.clear();
	vi.useRealTimers();
});

describe("SacnSource", () => {
	it("implicitly creates sparse outputs with 512 slots and default priority", async () => {
		const { source } = createSource();
		const universe = source.universe(1);

		const output = await universe.setChannels({ 1: 255, 512: 64 });

		expect(output.priority).toBe(100);
		expect(output.current).toHaveLength(SLOT_COUNT);
		expect(output.current[0]).toBe(255);
		expect(output.current[511]).toBe(64);
		expect(await universe.get()).toEqual(output);
		expect(source.getTelemetry().running).toBe(true);
	});

	it("caches universe handles by universe and priority", () => {
		const { source } = createSource();
		const first = source.universe(1);
		const again = source.universe(1, { priority: 100 });
		const other = source.universe(1, { priority: 120 });
		expect(again).toBe(first);
		expect(other).not.toBe(first);
		expect(other.priority).toBe(120);
	});

	it("validates an entire sparse request before changing state", async () => {
		const { source } = createSource();
		const universe = source.universe(1);

		await expect(universe.setChannels({ 1: 255, 513: 1 })).rejects.toBeInstanceOf(
			SacnValidationError,
		);
		expect(await source.listUniverses()).toHaveLength(0);
	});

	it("rejects malformed full frames without Uint8Array coercion", async () => {
		const { source } = createSource();
		const values = Array.from({ length: SLOT_COUNT }, () => 0);
		values[10] = 256;

		await expect(source.universe(1).write(values)).rejects.toMatchObject({
			code: "INVALID_FRAME",
		});
	});

	it("returns deeply immutable, detached snapshots", async () => {
		const { source } = createSource();
		const output = await source.universe(1).setChannels({ 1: 100 });

		expect(Object.isFrozen(output)).toBe(true);
		expect(Object.isFrozen(output.current)).toBe(true);
		expect(() => {
			(output.current as number[])[0] = 12;
		}).toThrow();
		expect((await source.universe(1).get())?.current[0]).toBe(100);
	});

	it("interpolates each fading channel linearly via transition", async () => {
		const clock = new ManualClock();
		const { source } = createSource(undefined, { clock });
		await source.universe(1).transition([
			{ channel: 1, value: 200, durationMs: 1000 },
			{ channel: 2, value: 100, durationMs: 500 },
		]);

		clock.time = 250;
		const first = await source.universe(1).get();
		expect(first?.current.slice(0, 2)).toEqual([50, 50]);

		clock.time = 500;
		const second = await source.universe(1).get();
		expect(second?.current.slice(0, 2)).toEqual([100, 100]);
		expect(second?.activeTransitions).toBe(1);
	});

	it("uses fadeChannels for a shared duration", async () => {
		const clock = new ManualClock();
		const { source } = createSource(undefined, { clock });
		await source.universe(1).fadeChannels(
			{ 1: 200, 2: 100 },
			{ durationMs: 1000 },
		);

		clock.time = 500;
		const snapshot = await source.universe(1).get();
		expect(snapshot?.current.slice(0, 2)).toEqual([100, 50]);
		expect(snapshot?.activeTransitions).toBe(2);
	});

	it("does not auto-start on reads", async () => {
		const { source } = createSource();
		expect(await source.universe(1).get()).toBeNull();
		expect(source.getTelemetry().running).toBe(false);
		expect(await source.listUniverses()).toEqual([]);
		expect(source.getTelemetry().running).toBe(false);
	});

	it("stop pauses the scheduler and mutations restart it", async () => {
		const hooks: string[] = [];
		const { source, transport } = createSource(undefined, {
			onStart: () => {
				hooks.push("start");
			},
			onStop: () => {
				hooks.push("stop");
			},
		});
		await source.universe(1).setChannels({ 1: 1 });
		await vi.waitFor(() => {
			expect(source.getTelemetry().transport.sendSuccesses).toBe(1);
		});
		await source.stop();
		expect(source.getTelemetry().running).toBe(false);
		expect(hooks).toEqual(["start", "stop"]);

		const before = transport.packets.length;
		await source.universe(1).setChannels({ 1: 2 });
		await vi.waitFor(() => {
			expect(transport.packets.length).toBeGreaterThan(before);
		});
		expect(source.getTelemetry().running).toBe(true);
		expect(hooks).toEqual(["start", "stop", "start"]);
	});

	it("uses configured active and per-output idle frame rates", async () => {
		const clock = new ManualClock();
		const { source } = createSource(undefined, {
			activeFps: 44,
			idleFps: 4,
			clock,
		});
		const fading = await source.universe(1).fadeChannels(
			{ 1: 255 },
			{ durationMs: 1000 },
		);
		expect(fading.activeTransitions).toBe(1);
		await source.start();
		await vi.waitFor(() => {
			expect(source.getTelemetry().transport.sendSuccesses).toBe(1);
		});

		const active = await source.universe(1).get();
		expect(active?.activeTransitions).toBe(1);
		expect(
			(active?.nextDueAt ?? 0) - (active?.lastSentAt ?? 0),
		).toBeCloseTo(1000 / 44);

		await source.universe(2, { idleFps: 5 }).write(new Uint8Array(SLOT_COUNT));
		await vi.waitFor(() => {
			expect(source.getTelemetry().transport.sendSuccesses).toBe(2);
		});
		const idle = await source.universe(2).get();
		expect((idle?.nextDueAt ?? 0) - (idle?.lastSentAt ?? 0)).toBeCloseTo(200);
	});

	it("starts due sends concurrently across outputs", async () => {
		vi.useFakeTimers();
		const transport = new RecordingTransport();
		const releases: (() => void)[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		transport.sendImplementation = (_packet, signal) =>
			new Promise<void>((resolve, reject) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				releases.push(() => {
					inFlight -= 1;
					resolve();
				});
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		const store = new MemoryOutputStore();
		const blank = Array.from({ length: SLOT_COUNT }, () => 0);
		await store.save({
			universe: 1,
			priority: 100,
			cid: TEST_CID,
			idleFps: 2,
			sourceName: null,
			target: blank,
			updatedAt: 0,
		});
		await store.save({
			universe: 2,
			priority: 100,
			cid: "00000000-0000-4000-8000-000000000002",
			idleFps: 2,
			sourceName: null,
			target: blank,
			updatedAt: 0,
		});
		const { source } = createSource(transport, {
			store,
			sendTimeoutMs: 1000,
		});
		await source.start();
		await vi.advanceTimersByTimeAsync(1);
		expect(transport.packets).toHaveLength(2);
		expect(maxInFlight).toBe(2);
		releases.forEach((release) => release());
		await vi.advanceTimersByTimeAsync(1);
	});

	it("records send timeouts and restores persisted output state", async () => {
		const store = new MemoryOutputStore();
		const blockedTransport = new RecordingTransport();
		blockedTransport.sendImplementation = (_packet, signal) =>
			new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		const first = createSource(blockedTransport, {
			store,
			sendTimeoutMs: 5,
		}).source;
		await first.universe(10, { idleFps: 7 }).setChannels({ 10: 99 });
		await first.start();
		await vi.waitFor(() => {
			expect(first.getTelemetry().transport.sendTimeouts).toBeGreaterThan(0);
		});
		await first.close();

		const second = createSource(undefined, { store }).source;
		await second.start();
		const restored = await second.universe(10).get();
		expect(restored?.target[9]).toBe(99);
		expect(restored?.idleFps).toBe(7);
	});

	it("blackouts before clearing and cancels blocked sends on close", async () => {
		vi.useFakeTimers();
		const transport = new RecordingTransport();
		const { source } = createSource(transport);
		await source.universe(1).setChannels({ 1: 255 });
		expect(await source.universe(1).clear()).toBe(true);
		expect(transport.packets.at(-1)?.data.every((value) => value === 0)).toBe(
			true,
		);
		expect(transport.closedOutputs).toEqual([{ universe: 1, priority: 100 }]);

		transport.sendImplementation = (_packet, signal) =>
			new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		await source.universe(2).setChannels({ 1: 1 });
		await source.start();
		await vi.advanceTimersByTimeAsync(1);
		await source.close();
		expect(transport.closed).toBe(true);
		await expect(source.listUniverses()).rejects.toBeInstanceOf(
			SacnLifecycleError,
		);
	});
});

describe("MemoryOutputStore", () => {
	it("copies records on save and read", async () => {
		const store = new MemoryOutputStore();
		const target = Array.from({ length: SLOT_COUNT }, () => 0);
		await store.save({
			universe: 1,
			priority: 100,
			cid: TEST_CID,
			idleFps: 2,
			sourceName: null,
			target,
			updatedAt: 0,
		});
		target[0] = 255;

		const record = await store.get({ universe: 1, priority: 100 });
		expect(record?.target[0]).toBe(0);
		expect(Object.isFrozen(record?.target)).toBe(true);
	});
});
