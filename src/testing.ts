import type {
  Clock,
  OutputAddress,
  OutputPacket,
  OutputTransport,
  Receiver,
  ReceiverPacket,
  ReceiverPacketListener,
} from "./contracts.js";

interface Sleeper {
  readonly dueAt: number;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

export class FakeClock implements Clock {
  #now: number;
  readonly #sleepers = new Set<Sleeper>();

  constructor(now = 0) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const sleeper: Sleeper = {
        dueAt: this.#now + Math.max(0, delayMs),
        resolve,
        reject,
      };
      this.#sleepers.add(sleeper);
      signal.addEventListener(
        "abort",
        () => {
          if (this.#sleepers.delete(sleeper)) reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  advanceBy(milliseconds: number): void {
    this.advanceTo(this.#now + milliseconds);
  }

  advanceTo(timestamp: number): void {
    if (!Number.isFinite(timestamp) || timestamp < this.#now) {
      throw new RangeError("Fake clock cannot move backwards.");
    }
    this.#now = timestamp;
    for (const sleeper of [...this.#sleepers]) {
      if (sleeper.dueAt <= timestamp) {
        this.#sleepers.delete(sleeper);
        sleeper.resolve();
      }
    }
  }
}

export class RecordingTransport implements OutputTransport {
  readonly packets: OutputPacket[] = [];
  readonly closedOutputs: Required<OutputAddress>[] = [];
  closeCalls = 0;
  sendImplementation?: (
    packet: OutputPacket,
    signal: AbortSignal,
  ) => Promise<void>;

  async send(packet: OutputPacket, signal: AbortSignal): Promise<void> {
    const copy: OutputPacket = Object.freeze({
      ...packet,
      data: packet.data.slice(),
    });
    this.packets.push(copy);
    await this.sendImplementation?.(copy, signal);
  }

  async closeOutput(address: Required<OutputAddress>): Promise<void> {
    this.closedOutputs.push(Object.freeze({ ...address }));
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

export class FakeReceiver implements Receiver {
  readonly universes = new Set<number>();
  readonly #listeners = new Set<ReceiverPacketListener>();
  closed = false;

  addUniverse(universe: number): void {
    this.universes.add(universe);
  }

  removeUniverse(universe: number): void {
    this.universes.delete(universe);
  }

  subscribe(listener: ReceiverPacketListener): () => void {
    if (this.closed) throw new Error("Fake receiver is closed.");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(packet: ReceiverPacket): void {
    for (const listener of this.#listeners) listener(packet);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#listeners.clear();
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export const createDeferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
