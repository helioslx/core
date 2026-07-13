import {
	type ChannelValues,
	type ClearUniverseOptions,
	type EngineTelemetry,
	type FadeChannelsOptions,
	type Logger,
	type OutputOptions,
	type OutputRecord,
	type OutputSnapshot,
	type OutputStore,
	type SacnLifecycleHook,
	type SacnSourceContract,
	type SacnSourceEvent,
	type SacnSourceOptions,
	type TransitionWrite,
	type UniverseContract,
	type UniverseOptions,
	type WriteFrameOptions,
	DEFAULT_PRIORITY,
} from "./contracts.js";
import { MemoryOutputStore } from "./memory-store.js";
import { OutputEngine, SystemClock } from "./output-engine.js";
import {
	SacnLifecycleError,
	PersistenceError,
	assertFade,
	channelValuesToWrites,
	normalizeAddress,
	toValidatedFrame,
	validateTransitionWrites,
} from "./validation.js";

const noopLogger: Logger = Object.freeze({});

const defaultCreateId = (): string => {
	if (typeof globalThis.crypto?.randomUUID !== "function") {
		throw new SacnLifecycleError(
			"No UUID generator is available; inject createId in source options.",
		);
	}
	return globalThis.crypto.randomUUID();
};

const toRecord = (snapshot: OutputSnapshot): OutputRecord =>
	Object.freeze({
		universe: snapshot.universe,
		priority: snapshot.priority,
		cid: snapshot.cid,
		sourceName: snapshot.sourceName,
		idleFps: snapshot.idleFps,
		target: Object.freeze([...snapshot.target]),
		updatedAt: snapshot.updatedAt,
	});

const outputOptionsFrom = (
	universe: number,
	priority: number,
	defaults: UniverseOptions,
): OutputOptions => ({
	universe,
	priority,
	...(defaults.cid === undefined ? {} : { cid: defaults.cid }),
	...(defaults.idleFps === undefined ? {} : { idleFps: defaults.idleFps }),
	...(defaults.sourceName === undefined
		? {}
		: { sourceName: defaults.sourceName }),
});

/**
 * Thin handle for a single `(universe, priority)` output address.
 */
export class Universe implements UniverseContract {
	readonly #source: SacnSource;
	readonly #defaults: UniverseOptions;
	readonly universe: number;
	readonly priority: number;

	constructor(
		source: SacnSource,
		universe: number,
		priority: number,
		defaults: UniverseOptions,
	) {
		this.#source = source;
		this.universe = universe;
		this.priority = priority;
		this.#defaults = defaults;
	}

	setChannels(
		values: ChannelValues,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<OutputSnapshot> {
		return this.#source.writeChannels(
			outputOptionsFrom(this.universe, this.priority, this.#defaults),
			() => channelValuesToWrites(values),
			options.signal,
		);
	}

	fadeChannels(
		values: ChannelValues,
		options: FadeChannelsOptions,
	): Promise<OutputSnapshot> {
		return this.#source.writeChannels(
			outputOptionsFrom(this.universe, this.priority, this.#defaults),
			() => {
				assertFade(options.durationMs);
				return channelValuesToWrites(values, options.durationMs);
			},
			options.signal,
		);
	}

	transition(
		writes: readonly TransitionWrite[],
		options: { readonly signal?: AbortSignal } = {},
	): Promise<OutputSnapshot> {
		return this.#source.writeChannels(
			outputOptionsFrom(this.universe, this.priority, this.#defaults),
			() => {
				validateTransitionWrites(writes);
				return writes.map((write) => ({
					channel: write.channel,
					value: write.value,
					durationMs: write.durationMs,
				}));
			},
			options.signal,
		);
	}

	write(
		values: readonly number[] | Uint8Array,
		options: WriteFrameOptions = {},
	): Promise<OutputSnapshot> {
		return this.#source.writeFrame(
			outputOptionsFrom(this.universe, this.priority, this.#defaults),
			values,
			options.durationMs ?? 0,
			options.signal,
		);
	}

	get(): Promise<OutputSnapshot | null> {
		return this.#source.getUniverse(this.universe, this.priority);
	}

	clear(options: ClearUniverseOptions = {}): Promise<boolean> {
		return this.#source.clearUniverse(
			this.universe,
			this.priority,
			options.signal,
		);
	}
}

/**
 * Runtime-neutral sACN output source over scheduling and storage.
 * Mutating requests are serialized so their returned and persisted snapshots
 * represent the same operation order.
 */
export class SacnSource implements SacnSourceContract {
	readonly #store: OutputStore;
	readonly #engine: OutputEngine;
	readonly #ownsStore: boolean;
	readonly #logger: Logger;
	readonly #onStart?: SacnLifecycleHook;
	readonly #onStop?: SacnLifecycleHook;
	readonly #onClose?: SacnLifecycleHook;
	readonly #listeners = new Set<(event: SacnSourceEvent) => void>();
	readonly #universes = new Map<string, Universe>();
	#queue: Promise<void> = Promise.resolve();
	#running = false;
	#restored = false;
	#closing = false;
	#closed = false;
	#closePromise: Promise<void> | null = null;

	constructor(options: SacnSourceOptions) {
		this.#store = options.store ?? new MemoryOutputStore();
		this.#ownsStore = options.ownsStore ?? options.store === undefined;
		this.#logger = options.logger ?? noopLogger;
		if (options.onStart !== undefined) this.#onStart = options.onStart;
		if (options.onStop !== undefined) this.#onStop = options.onStop;
		if (options.onClose !== undefined) this.#onClose = options.onClose;
		this.#engine = new OutputEngine({
			transport: options.transport,
			clock: options.clock ?? new SystemClock(),
			logger: this.#logger,
			createId: options.createId ?? defaultCreateId,
			...(options.activeFps === undefined
				? {}
				: { activeFps: options.activeFps }),
			...(options.idleFps === undefined ? {} : { idleFps: options.idleFps }),
			...(options.sendTimeoutMs === undefined
				? {}
				: { sendTimeoutMs: options.sendTimeoutMs }),
			...(options.shutdownTimeoutMs === undefined
				? {}
				: { shutdownTimeoutMs: options.shutdownTimeoutMs }),
			...(options.maxOutputs === undefined
				? {}
				: { maxOutputs: options.maxOutputs }),
			closeTransport: options.ownsTransport ?? false,
		});
	}

	universe(universe: number, options: UniverseOptions = {}): Universe {
		if (this.#closing || this.#closed) {
			throw new SacnLifecycleError("Source is closed.");
		}
		const address = normalizeAddress({
			universe,
			priority: options.priority ?? DEFAULT_PRIORITY,
		});
		const key = `${address.universe}:${address.priority}`;
		const existing = this.#universes.get(key);
		if (existing) return existing;
		const handle = new Universe(this, address.universe, address.priority, {
			...(options.cid === undefined ? {} : { cid: options.cid }),
			...(options.idleFps === undefined ? {} : { idleFps: options.idleFps }),
			...(options.sourceName === undefined
				? {}
				: { sourceName: options.sourceName }),
		});
		this.#universes.set(key, handle);
		return handle;
	}

	start(): Promise<void> {
		return this.#enqueue(async () => {
			await this.#startLocked();
		});
	}

	stop(): Promise<void> {
		return this.#enqueue(async () => {
			if (this.#closed) {
				throw new SacnLifecycleError("Source is closed.");
			}
			if (!this.#running) return;
			await this.#engine.stop();
			this.#running = false;
			await this.#runHook(this.#onStop);
			this.#emit({ type: "stopped" });
		});
	}

	/** @internal Used by Universe handles. */
	writeFrame(
		options: OutputOptions,
		values: readonly number[] | Uint8Array,
		durationMs: number,
		signal?: AbortSignal,
	): Promise<OutputSnapshot> {
		return this.#enqueue(async () => {
			await this.#ensureStartedLocked();
			const frame = toValidatedFrame(values);
			assertFade(durationMs);
			const checkpoint = await this.#engine.beginMutation(options);
			try {
				const snapshot = this.#engine.writeFrame(options, frame, durationMs);
				await this.#persist("save output", () =>
					this.#store.save(toRecord(snapshot)),
				);
				this.#engine.commitMutation(checkpoint);
				this.#emit({ type: "output-updated", output: snapshot });
				return snapshot;
			} catch (error) {
				this.#engine.rollbackMutation(checkpoint);
				throw error;
			}
		}, signal);
	}

	/** @internal Used by Universe handles. */
	writeChannels(
		options: OutputOptions,
		resolveChannels: () => ReturnType<typeof channelValuesToWrites>,
		signal?: AbortSignal,
	): Promise<OutputSnapshot> {
		return this.#enqueue(async () => {
			await this.#ensureStartedLocked();
			const channels = resolveChannels();
			const checkpoint = await this.#engine.beginMutation(options);
			try {
				const snapshot = this.#engine.writeChannels(options, channels);
				await this.#persist("save output", () =>
					this.#store.save(toRecord(snapshot)),
				);
				this.#engine.commitMutation(checkpoint);
				this.#emit({ type: "output-updated", output: snapshot });
				return snapshot;
			} catch (error) {
				this.#engine.rollbackMutation(checkpoint);
				throw error;
			}
		}, signal);
	}

	/** @internal Used by Universe handles. */
	getUniverse(
		universe: number,
		priority: number,
	): Promise<OutputSnapshot | null> {
		return this.#enqueue(() =>
			Promise.resolve(
				this.#engine.getOutput(normalizeAddress({ universe, priority })),
			),
		);
	}

	listUniverses(): Promise<readonly OutputSnapshot[]> {
		return this.#enqueue(() => Promise.resolve(this.#engine.listOutputs()));
	}

	/** @internal Used by Universe handles. */
	clearUniverse(
		universe: number,
		priority: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		return this.#enqueue(async () => {
			await this.#ensureStartedLocked();
			const address = normalizeAddress({ universe, priority });
			const checkpoint = await this.#engine.beginMutation(address);
			const previous = this.#engine.getOutput(address);
			if (!previous) {
				this.#engine.commitMutation(checkpoint);
				return false;
			}
			let persistenceRemoved = false;
			try {
				await this.#persist("remove output", () => this.#store.remove(address));
				persistenceRemoved = true;
				const removed = await this.#engine.clearOutput(address);
				this.#engine.commitMutation(checkpoint);
				this.#emit({
					type: "output-cleared",
					address: Object.freeze({ ...address }),
				});
				return removed;
			} catch (error) {
				this.#engine.rollbackMutation(checkpoint);
				if (persistenceRemoved) {
					try {
						await this.#persist("restore output after failed clear", () =>
							this.#store.save(toRecord(previous)),
						);
					} catch (rollbackError) {
						throw new AggregateError(
							[error, rollbackError],
							"Output clear and persistence rollback failed.",
						);
					}
				}
				throw error;
			}
		}, signal);
	}

	getTelemetry(): EngineTelemetry {
		return this.#engine.getTelemetry();
	}

	subscribe(listener: (event: SacnSourceEvent) => void): () => void {
		if (this.#closing || this.#closed) {
			throw new SacnLifecycleError("Source is closed.");
		}
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closing = true;
		const closing = this.#queue.then(async () => {
			const errors: unknown[] = [];
			try {
				try {
					await this.#engine.close();
				} catch (error) {
					errors.push(error);
				}
				if (this.#ownsStore) {
					try {
						await this.#persist("close output store", async () => {
							await this.#store.close?.();
						});
					} catch (error) {
						errors.push(error);
					}
				}
				try {
					await this.#runHook(this.#onClose);
				} catch (error) {
					errors.push(error);
				}
				if (errors.length === 1) {
					throw errors[0];
				}
				if (errors.length > 1) {
					throw new AggregateError(errors, "Source shutdown failed.");
				}
			} finally {
				this.#running = false;
				this.#closed = true;
				this.#closing = false;
				this.#universes.clear();
				this.#emit({ type: "closed" });
				this.#listeners.clear();
			}
		});
		this.#queue = closing.then(
			() => undefined,
			() => undefined,
		);
		this.#closePromise = closing;
		return closing;
	}

	async #startLocked(): Promise<void> {
		if (this.#closed) {
			throw new SacnLifecycleError("Source is closed.");
		}
		if (this.#running) return;
		if (!this.#restored) {
			const records = await this.#persist("load outputs", () =>
				this.#store.list(),
			);
			const checkpoints = [];
			try {
				for (const record of records) {
					const checkpoint = await this.#engine.beginMutation(record);
					checkpoints.push(checkpoint);
					this.#engine.restore(record);
					this.#engine.commitMutation(checkpoint);
				}
				this.#restored = true;
			} catch (error) {
				for (const checkpoint of checkpoints.reverse()) {
					this.#engine.rollbackMutation(checkpoint);
				}
				throw error;
			}
		}
		this.#engine.start();
		this.#running = true;
		await this.#runHook(this.#onStart);
		this.#emit({ type: "started" });
	}

	async #ensureStartedLocked(): Promise<void> {
		if (!this.#running) {
			await this.#startLocked();
		}
	}

	async #runHook(hook: SacnLifecycleHook | undefined): Promise<void> {
		if (!hook) return;
		await hook();
	}

	#enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.#closing || this.#closed) {
			return Promise.reject(new SacnLifecycleError("Source is closed."));
		}
		const result = this.#queue.then(() => {
			signal?.throwIfAborted();
			return operation();
		});
		this.#queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #persist<T>(action: string, operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof PersistenceError) throw error;
			throw new PersistenceError(`Failed to ${action}.`, error);
		}
	}

	#emit(event: SacnSourceEvent): void {
		const frozenEvent = Object.freeze(event);
		for (const listener of this.#listeners) {
			try {
				listener(frozenEvent);
			} catch (error) {
				this.#logger.warn?.("Source event listener failed.", { error });
			}
		}
	}
}

export const createSacnSource = (options: SacnSourceOptions): SacnSource =>
	new SacnSource(options);
