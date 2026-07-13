import { Buffer } from "node:buffer";
import { createSocket, type Socket } from "node:dgram";
import { Packet, Receiver as SacnReceiver } from "sacn";
import {
	type Logger,
	type OutputAddress,
	type OutputPacket,
	type OutputTransport,
	type Receiver,
	type ReceiverPacket,
	type ReceiverPacketListener,
	type SacnSourceOptions,
	SLOT_COUNT,
} from "./contracts.js";
import { createSacnSource as createCoreSacnSource, type SacnSource } from "./source.js";
import {
	assertCid,
	assertPort,
	assertSourceName,
	normalizeAddress,
	SacnValidationError,
	TransportError,
	toValidatedFrame,
} from "./validation.js";

const activeSources = new Set<SacnSource>();
let processHandlersInstalled = false;
let shuttingDown = false;

const unregisterSource = (source: SacnSource): void => {
	activeSources.delete(source);
};

const closeRegisteredSources = async (): Promise<void> => {
	const sources = [...activeSources];
	activeSources.clear();
	await Promise.allSettled(sources.map((source) => source.close()));
};

const onProcessShutdown = (signal: NodeJS.Signals | "beforeExit"): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	void closeRegisteredSources().finally(() => {
		if (signal === "beforeExit") return;
		// Allow default signal behavior after teardown when no other listeners remain.
		if (process.listenerCount(signal) === 0) {
			process.exit(signal === "SIGINT" ? 130 : 143);
		}
	});
};

const installProcessHandlers = (): void => {
	if (processHandlersInstalled) return;
	processHandlersInstalled = true;
	process.once("SIGINT", () => onProcessShutdown("SIGINT"));
	process.once("SIGTERM", () => onProcessShutdown("SIGTERM"));
	process.once("beforeExit", () => onProcessShutdown("beforeExit"));
};

/** Test helper: close and clear the Node active-source registry. */
export const flushActiveSacnSourcesForTests = async (): Promise<void> => {
	await closeRegisteredSources();
	shuttingDown = false;
};

/** Test helper: whether process signal handlers are installed. */
export const areProcessHandlersInstalledForTests = (): boolean =>
	processHandlersInstalled;

export interface NodeRuntimeTelemetry {
	readonly cpuUsage: {
		readonly systemMicroseconds: number;
		readonly userMicroseconds: number;
	};
	readonly memoryUsage: {
		readonly arrayBuffersBytes: number;
		readonly externalBytes: number;
		readonly heapTotalBytes: number;
		readonly heapUsedBytes: number;
		readonly rssBytes: number;
	};
	readonly pid: number;
	readonly uptimeSeconds: number;
}

export const getNodeRuntimeTelemetry = (): NodeRuntimeTelemetry => {
	const cpu = process.cpuUsage();
	const memory = process.memoryUsage();
	return Object.freeze({
		cpuUsage: Object.freeze({
			systemMicroseconds: cpu.system,
			userMicroseconds: cpu.user,
		}),
		memoryUsage: Object.freeze({
			arrayBuffersBytes: memory.arrayBuffers,
			externalBytes: memory.external,
			heapTotalBytes: memory.heapTotal,
			heapUsedBytes: memory.heapUsed,
			rssBytes: memory.rss,
		}),
		pid: process.pid,
		uptimeSeconds: process.uptime(),
	});
};

export interface NodeSender {
	send(packet: {
		cid: Buffer;
		payload: Record<number, number>;
		priority: number;
		sequence: number;
		sourceName: string;
		useRawDmxValues: true;
	}): Promise<void>;
	close(): unknown;
	on?(event: "error", listener: (error: Error) => void): unknown;
}

export interface NodeSenderOptions {
	readonly universe: number;
	readonly port: number;
	readonly iface?: string;
	readonly useUnicastDestination?: string;
}

export interface NodeSacnTransportOptions {
	readonly iface?: string;
	readonly port?: number;
	readonly sourceName?: string;
	/** Optional unicast destination for testing or networks that require it. */
	readonly unicastDestination?: string;
	readonly senderFactory?: (options: NodeSenderOptions) => NodeSender;
	readonly logger?: Logger;
}

export interface CreateSacnSourceOptions
	extends Omit<SacnSourceOptions, "ownsTransport" | "transport"> {
	readonly name?: string;
	readonly transportOptions?: NodeSacnTransportOptions;
	/**
	 * Install process SIGINT/SIGTERM/beforeExit handlers that close all
	 * registered Node sources. Defaults to true.
	 */
	readonly installProcessHandlers?: boolean;
}

export const createSacnSource = (
	options: CreateSacnSourceOptions = {},
): SacnSource => {
	const {
		name,
		transportOptions,
		installProcessHandlers: shouldInstallHandlers = true,
		...sourceOptions
	} = options;
	const transport = new NodeSacnTransport({
		...transportOptions,
		...(name === undefined
			? {}
			: { sourceName: transportOptions?.sourceName ?? name }),
	});
	const source = createCoreSacnSource({
		...sourceOptions,
		transport,
		ownsTransport: true,
	});
	activeSources.add(source);
	source.subscribe((event) => {
		if (event.type === "closed") unregisterSource(source);
	});
	if (shouldInstallHandlers) installProcessHandlers();
	return source;
};

const multicastGroup = (universe: number): string =>
	`239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;

class DefaultNodeSender implements NodeSender {
	readonly #socket: Socket;
	readonly #ready: Promise<void>;
	readonly #universe: number;
	readonly #port: number;
	readonly #destination: string;
	#closed = false;

	constructor(options: NodeSenderOptions) {
		this.#universe = options.universe;
		this.#port = options.port;
		this.#destination =
			options.useUnicastDestination ?? multicastGroup(options.universe);
		this.#socket = createSocket({ type: "udp4", reuseAddr: true });
		this.#ready = new Promise((resolve, reject) => {
			const onError = (error: Error): void => {
				this.#socket.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				this.#socket.off("error", onError);
				if (options.iface && !options.useUnicastDestination) {
					this.#socket.setMulticastInterface(options.iface);
				}
				resolve();
			};
			this.#socket.once("error", onError);
			this.#socket.once("listening", onListening);
			this.#socket.bind(0);
		});
	}

	on(event: "error", listener: (error: Error) => void): unknown {
		this.#socket.on(event, listener);
		return this;
	}

	async send(packet: {
		cid: Buffer;
		payload: Record<number, number>;
		priority: number;
		sequence: number;
		sourceName: string;
		useRawDmxValues: true;
	}): Promise<void> {
		await this.#ready;
		if (this.#closed) throw new Error("sACN sender is closed.");
		const wire = new Packet({
			cid: packet.cid,
			payload: packet.payload,
			priority: packet.priority || 1,
			sequence: packet.sequence,
			sourceName: packet.sourceName,
			universe: this.#universe,
			useRawDmxValues: true,
		}).buffer;
		// sacn 4.x applies `priority || 100`; restore standards-valid priority 0.
		wire[108] = packet.priority;
		// Preserve the engine's sequence even if the encoder changes its policy.
		wire[111] = packet.sequence;
		await new Promise<void>((resolve, reject) => {
			this.#socket.send(wire, this.#port, this.#destination, (error) =>
				error ? reject(error) : resolve(),
			);
		});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket.close();
	}
}

const uuidBuffer = (cid: string): Buffer =>
	Buffer.from(cid.replaceAll("-", ""), "hex");

const truncateUtf8 = (value: string, maximumBytes: number): string => {
	let result = value;
	while (Buffer.byteLength(result, "utf8") > maximumBytes) {
		result = result.slice(0, -1);
	}
	return result;
};

const sourceNameFor = (
	base: string,
	suffix: string | null,
	universe: number,
	priority: number,
): string =>
	truncateUtf8(
		[base, suffix, `${universe}/${priority}`]
			.filter(Boolean)
			.join(" ")
			.replace(/[^\x20-\x7e]/g, "?"),
		64,
	);

interface SenderContext {
	readonly sender: NodeSender;
	readonly cid: string;
	readonly sourceName: string;
	readonly payload: Record<number, number>;
}

const createPayload = (): Record<number, number> => {
	const payload: Record<number, number> = {};
	for (let channel = 1; channel <= SLOT_COUNT; channel += 1) {
		payload[channel] = 0;
	}
	return payload;
};

const updatePayload = (
	payload: Record<number, number>,
	data: Uint8Array,
): void => {
	for (let channel = 1; channel <= SLOT_COUNT; channel += 1) {
		payload[channel] = data[channel - 1] ?? 0;
	}
};

export class NodeSacnTransport implements OutputTransport {
	readonly #options: NodeSacnTransportOptions;
	readonly #senders = new Map<string, SenderContext>();
	#closed = false;

	constructor(options: NodeSacnTransportOptions = {}) {
		assertPort(options.port ?? 5568);
		if (options.sourceName !== undefined) assertSourceName(options.sourceName);
		this.#options = options;
	}

	async send(packet: OutputPacket, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.#closed)
			throw new TransportError("Node sACN transport is closed.");
		normalizeAddress(packet);
		assertCid(packet.cid);
		if (packet.sourceName !== null) assertSourceName(packet.sourceName);
		if (
			!Number.isInteger(packet.sequence) ||
			packet.sequence < 0 ||
			packet.sequence > 255
		) {
			throw new SacnValidationError(
				"Sequence must be an integer between 0 and 255.",
				"INVALID_FRAME",
			);
		}
		const frame = toValidatedFrame(packet.data);
		const key = `${packet.universe}:${packet.priority}`;
		const sourceName = sourceNameFor(
			this.#options.sourceName ?? "@helioslx/core",
			packet.sourceName,
			packet.universe,
			packet.priority,
		);
		let context = this.#senders.get(key);
		if (
			context &&
			(context.cid !== packet.cid || context.sourceName !== sourceName)
		) {
			context.sender.close();
			this.#senders.delete(key);
			context = undefined;
		}
		if (!context) {
			const senderOptions: NodeSenderOptions = {
				universe: packet.universe,
				port: this.#options.port ?? 5568,
				...(this.#options.iface === undefined
					? {}
					: { iface: this.#options.iface }),
				...(this.#options.unicastDestination === undefined
					? {}
					: { useUnicastDestination: this.#options.unicastDestination }),
			};
			const sender =
				this.#options.senderFactory?.(senderOptions) ??
				new DefaultNodeSender(senderOptions);
			sender.on?.("error", (error) => {
				this.#options.logger?.error?.("sACN sender error.", {
					error,
					universe: packet.universe,
					priority: packet.priority,
				});
			});
			context = {
				sender,
				cid: packet.cid,
				sourceName,
				payload: createPayload(),
			};
			this.#senders.set(key, context);
		}
		updatePayload(context.payload, frame);
		try {
			await context.sender.send({
				payload: context.payload,
				cid: uuidBuffer(packet.cid),
				priority: packet.priority,
				sequence: packet.sequence,
				sourceName,
				useRawDmxValues: true,
			});
			signal.throwIfAborted();
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			this.#senders.delete(key);
			try {
				context.sender.close();
			} catch {
				// A failed sender is discarded even when its close also fails.
			}
			throw new TransportError(
				`Node sACN sender failed for universe ${packet.universe}.`,
				error,
			);
		}
	}

	async closeOutput(address: Required<OutputAddress>): Promise<void> {
		const key = `${address.universe}:${address.priority}`;
		const context = this.#senders.get(key);
		if (!context) return;
		this.#senders.delete(key);
		context.sender.close();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const context of this.#senders.values()) context.sender.close();
		this.#senders.clear();
	}
}

interface SacnPacketLike {
	readonly cid: Buffer;
	readonly payload: Readonly<Record<number, number>>;
	readonly payloadAsBuffer?: Buffer | null;
	readonly priority: number;
	readonly sequence: number;
	readonly sourceAddress?: string;
	readonly sourceName: string;
	readonly universe: number;
}

export interface NodeReceiverInstance {
	addUniverse(universe: number): Promise<unknown> | unknown;
	removeUniverse(universe: number): Promise<unknown> | unknown;
	on(event: "packet", listener: (packet: SacnPacketLike) => void): unknown;
	on(
		event: "error" | "PacketCorruption" | "PacketOutOfOrder",
		listener: (error: Error) => void,
	): unknown;
	off?(event: "packet", listener: (packet: SacnPacketLike) => void): unknown;
	off?(
		event: "error" | "PacketCorruption" | "PacketOutOfOrder",
		listener: (error: Error) => void,
	): unknown;
	close(callback?: () => void): unknown;
	readonly ready?: Promise<void>;
	readonly socket?: {
		address(): unknown;
		once(event: "listening", listener: () => void): unknown;
	};
}

export interface NodeSacnReceiverOptions {
	readonly universes?: readonly number[];
	readonly iface?: string;
	readonly port?: number;
	readonly receiverFactory?: (options: {
		universes: number[];
		iface?: string;
		port: number;
	}) => NodeReceiverInstance;
	readonly logger?: Logger;
}

const cidString = (cid: Buffer): string => {
	const hex = cid.toString("hex").padEnd(32, "0").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export class NodeSacnReceiver implements Receiver {
	readonly #receiver: NodeReceiverInstance;
	readonly #listeners = new Set<ReceiverPacketListener>();
	readonly #onPacket: (packet: SacnPacketLike) => void;
	readonly #onError: (error: Error) => void;
	readonly #onPacketWarning: (error: Error) => void;
	readonly #ready: Promise<void>;
	#closed = false;

	constructor(options: NodeSacnReceiverOptions = {}) {
		assertPort(options.port ?? 5568);
		const universes = (options.universes ?? []).map(
			(universe) => normalizeAddress({ universe }).universe,
		);
		const receiverOptions = {
			universes,
			port: options.port ?? 5568,
			...(options.iface === undefined ? {} : { iface: options.iface }),
		};
		this.#receiver =
			options.receiverFactory?.(receiverOptions) ??
			(new SacnReceiver({
				...receiverOptions,
				reuseAddr: true,
			}) as unknown as NodeReceiverInstance);
		const ready =
			this.#receiver.ready ??
			(this.#receiver.socket
				? new Promise<void>((resolve, reject) => {
						const onReadyError = (error: Error): void => {
							this.#receiver.off?.("error", onReadyError);
							reject(error);
						};
						const onListening = (): void => {
							this.#receiver.off?.("error", onReadyError);
							resolve();
						};
						this.#receiver.on("error", onReadyError);
						try {
							this.#receiver.socket?.address();
							onListening();
						} catch {
							this.#receiver.socket?.once("listening", onListening);
						}
					})
				: Promise.resolve());
		void ready.catch(() => undefined);
		this.#ready = ready;
		this.#onPacket = (packet) => {
			const values = new Uint8Array(SLOT_COUNT);
			if (packet.payloadAsBuffer) {
				values.set(packet.payloadAsBuffer.subarray(0, SLOT_COUNT));
			} else {
				for (let channel = 1; channel <= SLOT_COUNT; channel += 1) {
					values[channel - 1] = packet.payload[channel] ?? 0;
				}
			}
			const normalized: ReceiverPacket = Object.freeze({
				universe: packet.universe,
				priority: packet.priority,
				sequence: packet.sequence,
				cid: cidString(packet.cid),
				sourceName: packet.sourceName || null,
				sourceAddress: packet.sourceAddress ?? null,
				values,
			});
			for (const listener of this.#listeners) listener(normalized);
		};
		this.#onError = (error) => {
			options.logger?.error?.("sACN receiver error.", { error });
		};
		this.#onPacketWarning = (error) => {
			options.logger?.warn?.("sACN receiver dropped or reordered a packet.", {
				error,
			});
		};
		this.#receiver.on("packet", this.#onPacket);
		this.#receiver.on("error", this.#onError);
		this.#receiver.on("PacketCorruption", this.#onPacketWarning);
		this.#receiver.on("PacketOutOfOrder", this.#onPacketWarning);
	}

	async addUniverse(universe: number): Promise<void> {
		await this.#ready;
		await this.#receiver.addUniverse(normalizeAddress({ universe }).universe);
	}

	async removeUniverse(universe: number): Promise<void> {
		await this.#ready;
		await this.#receiver.removeUniverse(
			normalizeAddress({ universe }).universe,
		);
	}

	subscribe(listener: ReceiverPacketListener): () => void {
		if (this.#closed) throw new TransportError("Node sACN receiver is closed.");
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#receiver.off?.("packet", this.#onPacket);
		this.#receiver.off?.("error", this.#onError);
		this.#receiver.off?.("PacketCorruption", this.#onPacketWarning);
		this.#receiver.off?.("PacketOutOfOrder", this.#onPacketWarning);
		this.#listeners.clear();
		await new Promise<void>((resolve) => {
			this.#receiver.close(resolve);
		});
	}
}
