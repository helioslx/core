import {
  MAX_UNIVERSE,
  MIN_UNIVERSE,
  SLOT_COUNT,
  type Logger,
  type ReceiverPacket,
  type ViewerPacket,
  type ViewerPacketStream,
  type ViewerRecord,
  type ViewerServiceContract,
  type ViewerServiceOptions,
  type ViewerStore,
  type ViewerTelemetry,
} from "./contracts.js";
import { PersistenceError, SacnLifecycleError, SacnValidationError } from "./validation.js";

const normalizeUniverses = (
  universes: readonly number[],
  maximum: number,
): readonly number[] => {
  const unique = [...new Set(universes)];
  for (const universe of unique) {
    if (
      !Number.isInteger(universe) ||
      universe < MIN_UNIVERSE ||
      universe > MAX_UNIVERSE
    ) {
      throw new SacnValidationError(
        `Universe must be an integer between ${MIN_UNIVERSE} and ${MAX_UNIVERSE}.`,
        "INVALID_UNIVERSE",
      );
    }
  }
  if (unique.length > maximum) {
    throw new SacnValidationError(
      `At most ${maximum} viewer universes may be selected.`,
      "INVALID_UNIVERSE",
    );
  }
  return Object.freeze(unique.sort((left, right) => left - right));
};

const normalizePacket = (packet: ReceiverPacket, receivedAt: number): ViewerPacket => {
  const values = Array.from({ length: SLOT_COUNT }, (_, index) => packet.values[index] ?? 0);
  return Object.freeze({
    universe: packet.universe,
    receivedAt,
    values: Object.freeze(values),
    source: Object.freeze({
      cid: packet.cid,
      priority: packet.priority,
      sequence: packet.sequence,
      sourceAddress: packet.sourceAddress,
      sourceName: packet.sourceName,
    }),
  });
};

class PacketStream implements ViewerPacketStream {
  readonly #capacity: number;
  readonly #onDrop: () => void;
  readonly #onClose: () => void;
  readonly #queue: ViewerPacket[] = [];
  readonly #waiting: Array<
    (result: IteratorResult<ViewerPacket>) => void
  > = [];
  #closed = false;

  constructor(capacity: number, onDrop: () => void, onClose: () => void) {
    this.#capacity = capacity;
    this.#onDrop = onDrop;
    this.#onClose = onClose;
  }

  push(packet: ViewerPacket): void {
    if (this.#closed) return;
    const resolve = this.#waiting.shift();
    if (resolve) {
      resolve({ value: packet, done: false });
      return;
    }
    const existing = this.#queue.findIndex(
      (queued) => queued.universe === packet.universe,
    );
    if (existing >= 0) {
      this.#queue.splice(existing, 1);
      this.#onDrop();
    } else if (this.#queue.length >= this.#capacity) {
      this.#queue.shift();
      this.#onDrop();
    }
    this.#queue.push(packet);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    for (const resolve of this.#waiting.splice(0)) {
      resolve({ value: undefined, done: true });
    }
    this.#onClose();
  }

  [Symbol.asyncIterator](): AsyncIterator<ViewerPacket> {
    return {
      next: async () => {
        const packet = this.#queue.shift();
        if (packet) return { value: packet, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<ViewerPacket>>((resolve) => {
          this.#waiting.push(resolve);
        });
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

export class ViewerService implements ViewerServiceContract {
  readonly #receiver: ViewerServiceOptions["receiver"];
  readonly #store: ViewerStore;
  readonly #clock: NonNullable<ViewerServiceOptions["clock"]>;
  readonly #logger: Logger;
  readonly #ownsReceiver: boolean;
  readonly #ownsStore: boolean;
  readonly #streamCapacity: number;
  readonly #maxUniverses: number;
  readonly #maxListeners: number;
  readonly #listeners = new Set<(packet: ViewerPacket) => void>();
  readonly #streams = new Set<PacketStream>();
  readonly #unsubscribe: () => void;
  #selected: readonly number[] = Object.freeze([]);
  #queue: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;
  #packetsReceived = 0;
  #droppedUpdates = 0;

  constructor(options: ViewerServiceOptions) {
    this.#receiver = options.receiver;
    this.#store = options.store ?? new MemoryViewerStore();
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#logger = options.logger ?? {};
    this.#ownsReceiver = options.ownsReceiver ?? false;
    this.#ownsStore = options.ownsStore ?? options.store === undefined;
    this.#streamCapacity = options.streamCapacity ?? 32;
    this.#maxUniverses = options.maxUniverses ?? 256;
    this.#maxListeners = options.maxListeners ?? 256;
    if (!Number.isInteger(this.#streamCapacity) || this.#streamCapacity < 1) {
      throw new SacnValidationError("Stream capacity must be a positive integer.", "INVALID_FRAME");
    }
    if (!Number.isInteger(this.#maxUniverses) || this.#maxUniverses < 1) {
      throw new SacnValidationError(
        "Maximum universes must be a positive integer.",
        "INVALID_UNIVERSE",
      );
    }
    if (!Number.isInteger(this.#maxListeners) || this.#maxListeners < 1) {
      throw new SacnValidationError(
        "Maximum listeners must be a positive integer.",
        "INVALID_FRAME",
      );
    }
    this.#unsubscribe = this.#receiver.subscribe((packet) => this.#receive(packet));
  }

  async start(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#started) return;
      const record = await this.#persist("load viewer state", () => this.#store.load());
      if (record) await this.#applyUniverses(record.selectedUniverses, false);
      this.#started = true;
    });
  }

  getSelectedUniverses(): readonly number[] {
    return this.#selected;
  }

  setSelectedUniverses(universes: readonly number[]): Promise<readonly number[]> {
    return this.#enqueue(async () => {
      await this.#applyUniverses(universes, true);
      return this.#selected;
    });
  }

  addUniverse(universe: number): Promise<readonly number[]> {
    return this.setSelectedUniverses([...this.#selected, universe]);
  }

  removeUniverse(universe: number): Promise<readonly number[]> {
    return this.setSelectedUniverses(this.#selected.filter((item) => item !== universe));
  }

  subscribe(listener: (packet: ViewerPacket) => void): () => void {
    this.#assertOpen();
    this.#assertListenerCapacity();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  packets(capacity = this.#streamCapacity): ViewerPacketStream {
    this.#assertOpen();
    this.#assertListenerCapacity();
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new SacnValidationError("Stream capacity must be a positive integer.", "INVALID_FRAME");
    }
    let stream: PacketStream;
    stream = new PacketStream(
      capacity,
      () => {
        this.#droppedUpdates += 1;
      },
      () => this.#streams.delete(stream),
    );
    this.#streams.add(stream);
    return stream;
  }

  getTelemetry(): ViewerTelemetry {
    return Object.freeze({
      selectedUniverses: this.#selected,
      packetsReceived: this.#packetsReceived,
      droppedUpdates: this.#droppedUpdates,
      streamCount: this.#streams.size,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    this.#unsubscribe();
    for (const stream of [...this.#streams]) stream.close();
    this.#listeners.clear();
    const errors: unknown[] = [];
    if (this.#ownsReceiver) {
      try {
        await this.#receiver.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#ownsStore) {
      try {
        await this.#persist("close viewer store", async () => {
          await this.#store.close?.();
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Viewer shutdown failed.");
    }
  }

  async #applyUniverses(universes: readonly number[], save: boolean): Promise<void> {
    const next = normalizeUniverses(universes, this.#maxUniverses);
    const previousSelection = this.#selected;
    const previous = new Set(previousSelection);
    const desired = new Set(next);
    try {
      for (const universe of previousSelection) {
        if (!desired.has(universe)) await this.#receiver.removeUniverse(universe);
      }
      for (const universe of next) {
        if (!previous.has(universe)) await this.#receiver.addUniverse(universe);
      }
      this.#selected = next;
      if (save) {
        await this.#persist("save viewer state", () =>
          this.#store.save({
            selectedUniverses: next,
            updatedAt: this.#clock.now(),
          }),
        );
      }
    } catch (error) {
      try {
        for (const universe of next) {
          if (!previous.has(universe)) {
            await this.#receiver.removeUniverse(universe);
          }
        }
        for (const universe of previousSelection) {
          if (!desired.has(universe)) {
            await this.#receiver.addUniverse(universe);
          }
        }
        this.#selected = previousSelection;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Viewer universe update and rollback failed.",
        );
      }
      throw error;
    }
  }

  #receive(packet: ReceiverPacket): void {
    if (this.#closed || !this.#selected.includes(packet.universe)) return;
    const normalized = normalizePacket(packet, this.#clock.now());
    this.#packetsReceived += 1;
    for (const listener of this.#listeners) {
      try {
        listener(normalized);
      } catch (error) {
        this.#logger.warn?.("Viewer packet listener failed.", { error });
      }
    }
    for (const stream of this.#streams) stream.push(normalized);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new SacnLifecycleError("Viewer service is closed."));
    }
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => undefined, () => undefined);
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

  #assertOpen(): void {
    if (this.#closed) throw new SacnLifecycleError("Viewer service is closed.");
  }

  #assertListenerCapacity(): void {
    if (this.#listeners.size + this.#streams.size >= this.#maxListeners) {
      throw new SacnLifecycleError(
        `Viewer subscriber limit of ${this.#maxListeners} has been reached.`,
      );
    }
  }
}

const cloneRecord = (record: ViewerRecord): ViewerRecord =>
  Object.freeze({
    selectedUniverses: Object.freeze([...record.selectedUniverses]),
    updatedAt: record.updatedAt,
  });

export class MemoryViewerStore implements ViewerStore {
  #record: ViewerRecord | null = null;

  async load(): Promise<ViewerRecord | null> {
    return this.#record ? cloneRecord(this.#record) : null;
  }

  async save(record: ViewerRecord): Promise<void> {
    this.#record = cloneRecord(record);
  }
}
