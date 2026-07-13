export const SLOT_COUNT = 512;
export const MIN_UNIVERSE = 1;
export const MAX_UNIVERSE = 63_999;
export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 200;
export const DEFAULT_PRIORITY = 100;
export const DEFAULT_ACTIVE_FPS = 44;
export const DEFAULT_IDLE_FPS = 2;

export interface OutputAddress {
	readonly universe: number;
	readonly priority?: number;
}

export interface OutputOptions extends OutputAddress {
	readonly cid?: string;
	readonly idleFps?: number;
	readonly sourceName?: string;
}

/** One-based DMX channel → value map used by setChannels / fadeChannels. */
export type ChannelValues = Readonly<Record<number, number>>;

export interface ChannelWrite {
	/** One-based DMX slot number. */
	readonly channel: number;
	readonly value: number;
	/** Linear transition duration in milliseconds. Defaults to 0 (snap). */
	readonly durationMs?: number;
}

export interface TransitionWrite {
	readonly channel: number;
	readonly value: number;
	readonly durationMs: number;
}

export interface FadeChannelsOptions {
	readonly durationMs: number;
	readonly signal?: AbortSignal;
}

export interface WriteFrameOptions {
	readonly durationMs?: number;
	readonly signal?: AbortSignal;
}

export interface ClearUniverseOptions {
	readonly signal?: AbortSignal;
}

export interface UniverseOptions {
	readonly priority?: number;
	readonly cid?: string;
	readonly idleFps?: number;
	readonly sourceName?: string;
}

export type FrameMode = "active" | "idle";

export interface OutputSnapshot {
	readonly activeTransitions: number;
	readonly cid: string;
	readonly current: readonly number[];
	readonly dirty: boolean;
	readonly frameMode: FrameMode;
	readonly idleFps: number;
	readonly lastError: string | null;
	readonly lastSent: readonly number[];
	readonly lastSentAt: number | null;
	readonly nextDueAt: number;
	readonly priority: number;
	readonly sequence: number;
	readonly sourceName: string | null;
	readonly target: readonly number[];
	readonly universe: number;
	readonly updatedAt: number;
}

export interface OutputRecord {
	readonly cid: string;
	readonly idleFps: number;
	readonly priority: number;
	readonly sourceName: string | null;
	readonly target: readonly number[];
	readonly universe: number;
	readonly updatedAt: number;
}

export interface OutputStore {
	get(address: Required<OutputAddress>): Promise<OutputRecord | null>;
	list(): Promise<readonly OutputRecord[]>;
	remove(address: Required<OutputAddress>): Promise<void>;
	save(record: OutputRecord): Promise<void>;
	close?(): Promise<void>;
}

export interface OutputPacket {
	readonly cid: string;
	readonly data: Uint8Array;
	readonly priority: number;
	readonly sequence: number;
	readonly sourceName: string | null;
	readonly universe: number;
}

export interface OutputTransport {
	send(packet: OutputPacket, signal: AbortSignal): Promise<void>;
	closeOutput?(address: Required<OutputAddress>): Promise<void>;
	close(): Promise<void>;
}

export interface Clock {
	/** Monotonic milliseconds used for scheduling. */
	now(): number;
	/** Wall-clock Unix milliseconds used for public and persisted metadata. */
	wallNow?(): number;
	sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}

export interface Logger {
	debug?(message: string, context?: Readonly<Record<string, unknown>>): void;
	info?(message: string, context?: Readonly<Record<string, unknown>>): void;
	warn?(message: string, context?: Readonly<Record<string, unknown>>): void;
	error?(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface TransportTelemetry {
	readonly sendAttempts: number;
	readonly sendFailures: number;
	readonly sendRetries: number;
	readonly sendSuccesses: number;
	readonly sendTimeouts: number;
}

export interface EngineTelemetry {
	readonly closed: boolean;
	readonly lastLoopCompletedAt: number | null;
	readonly lastLoopDurationMs: number | null;
	readonly lastLoopStartedAt: number | null;
	readonly loopIterations: number;
	readonly outputCount: number;
	readonly outputs: readonly OutputSnapshot[];
	readonly running: boolean;
	readonly transport: TransportTelemetry;
}

export type SacnLifecycleHook = () => void | Promise<void>;

export interface SacnSourceOptions {
	readonly transport: OutputTransport;
	readonly store?: OutputStore;
	readonly clock?: Clock;
	readonly logger?: Logger;
	readonly activeFps?: number;
	readonly idleFps?: number;
	readonly sendTimeoutMs?: number;
	/** Maximum time spent awaiting transport shutdown. Defaults to 2 seconds. */
	readonly shutdownTimeoutMs?: number;
	/** Maximum number of active universe/priority outputs. Defaults to 1024. */
	readonly maxOutputs?: number;
	/** Close the injected transport with the source. Defaults to false. */
	readonly ownsTransport?: boolean;
	/** Defaults to true for the default memory store, false for an injected store. */
	readonly ownsStore?: boolean;
	readonly createId?: () => string;
	readonly onStart?: SacnLifecycleHook;
	readonly onStop?: SacnLifecycleHook;
	readonly onClose?: SacnLifecycleHook;
}

export type SacnSourceEvent =
	| { readonly type: "started" }
	| { readonly type: "stopped" }
	| { readonly type: "output-updated"; readonly output: OutputSnapshot }
	| {
			readonly type: "output-cleared";
			readonly address: Required<OutputAddress>;
	  }
	| { readonly type: "closed" };

export interface UniverseContract {
	readonly universe: number;
	readonly priority: number;
	setChannels(
		values: ChannelValues,
		options?: { readonly signal?: AbortSignal },
	): Promise<OutputSnapshot>;
	fadeChannels(
		values: ChannelValues,
		options: FadeChannelsOptions,
	): Promise<OutputSnapshot>;
	transition(
		writes: readonly TransitionWrite[],
		options?: { readonly signal?: AbortSignal },
	): Promise<OutputSnapshot>;
	write(
		values: readonly number[] | Uint8Array,
		options?: WriteFrameOptions,
	): Promise<OutputSnapshot>;
	get(): Promise<OutputSnapshot | null>;
	clear(options?: ClearUniverseOptions): Promise<boolean>;
}

export interface SacnSourceContract {
	universe(universe: number, options?: UniverseOptions): UniverseContract;
	start(): Promise<void>;
	stop(): Promise<void>;
	listUniverses(): Promise<readonly OutputSnapshot[]>;
	getTelemetry(): EngineTelemetry;
	subscribe(listener: (event: SacnSourceEvent) => void): () => void;
	close(): Promise<void>;
}

export interface ReceiverPacket {
	readonly cid: string;
	readonly priority: number;
	readonly sequence: number;
	readonly sourceAddress: string | null;
	readonly sourceName: string | null;
	readonly universe: number;
	readonly values: Uint8Array;
}

export type ReceiverPacketListener = (packet: ReceiverPacket) => void;

/** Runtime-neutral source of normalized sACN packets. */
export interface Receiver {
	addUniverse(universe: number): Promise<void> | void;
	removeUniverse(universe: number): Promise<void> | void;
	subscribe(listener: ReceiverPacketListener): () => void;
	close(): Promise<void>;
}

export interface ViewerSourceMetadata {
	readonly cid: string;
	readonly priority: number;
	readonly sequence: number;
	readonly sourceAddress: string | null;
	readonly sourceName: string | null;
}

export interface ViewerPacket {
	readonly receivedAt: number;
	readonly source: ViewerSourceMetadata;
	readonly universe: number;
	/** Exactly 512 normalized values. */
	readonly values: readonly number[];
}

export interface ViewerRecord {
	readonly selectedUniverses: readonly number[];
	readonly updatedAt: number;
}

export interface ViewerStore {
	load(): Promise<ViewerRecord | null>;
	save(record: ViewerRecord): Promise<void>;
	close?(): Promise<void>;
}

export interface ViewerTelemetry {
	readonly droppedUpdates: number;
	readonly packetsReceived: number;
	readonly selectedUniverses: readonly number[];
	readonly streamCount: number;
}

export interface ViewerPacketStream extends AsyncIterable<ViewerPacket> {
	close(): void;
}

export interface ViewerServiceContract {
	start(): Promise<void>;
	getSelectedUniverses(): readonly number[];
	setSelectedUniverses(
		universes: readonly number[],
	): Promise<readonly number[]>;
	addUniverse(universe: number): Promise<readonly number[]>;
	removeUniverse(universe: number): Promise<readonly number[]>;
	subscribe(listener: (packet: ViewerPacket) => void): () => void;
	packets(capacity?: number): ViewerPacketStream;
	getTelemetry(): ViewerTelemetry;
	close(): Promise<void>;
}

export interface ViewerServiceOptions {
	readonly receiver: Receiver;
	readonly store?: ViewerStore;
	readonly clock?: Pick<Clock, "now">;
	readonly logger?: Logger;
	/** Close the injected receiver with this service. Defaults to false. */
	readonly ownsReceiver?: boolean;
	/** Defaults to true for the default memory store, false for an injected store. */
	readonly ownsStore?: boolean;
	/** Default queue capacity for streams. Defaults to 32. */
	readonly streamCapacity?: number;
	/** Maximum number of selected universes. Defaults to 256. */
	readonly maxUniverses?: number;
	/** Maximum combined callback and stream subscribers. Defaults to 256. */
	readonly maxListeners?: number;
}
