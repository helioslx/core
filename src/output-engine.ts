import {
  DEFAULT_ACTIVE_FPS,
  DEFAULT_IDLE_FPS,
  SLOT_COUNT,
  type ChannelWrite,
  type Clock,
  type EngineTelemetry,
  type FrameMode,
  type Logger,
  type OutputAddress,
  type OutputOptions,
  type OutputPacket,
  type OutputRecord,
  type OutputSnapshot,
  type OutputTransport,
} from "./contracts.js";
import {
  SacnLifecycleError,
  TransportError,
  TransportTimeoutError,
  assertCid,
  assertFade,
  assertFps,
  assertSourceName,
  assertTimeout,
  normalizeAddress,
  toValidatedFrame,
  validateChannelWrites,
} from "./validation.js";

interface Transition {
  readonly from: number;
  readonly to: number;
  readonly startedAt: number;
  readonly durationMs: number;
}

interface OutputState {
  readonly address: Required<OutputAddress>;
  cid: string;
  idleFps: number;
  sourceName: string | null;
  readonly current: Uint8Array;
  readonly target: Uint8Array;
  readonly lastSent: Uint8Array;
  readonly transitions: Map<number, Transition>;
  sequence: number;
  lastSentAt: number | null;
  nextDueAt: number;
  dirty: boolean;
  lastError: string | null;
  consecutiveFailures: number;
  updatedAt: number;
  revision: number;
  sending: Promise<boolean> | null;
  transportPending: Promise<void> | null;
}

export interface OutputMutationCheckpoint {
  readonly key: string;
  readonly state: OutputState | null;
}

interface OutputEngineOptions {
  readonly transport: OutputTransport;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activeFps?: number;
  readonly idleFps?: number;
  readonly sendTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxOutputs?: number;
  readonly closeTransport?: boolean;
  readonly createId: () => string;
}

const framesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const frozenFrame = (frame: Uint8Array): readonly number[] =>
  Object.freeze(Array.from(frame));

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class SystemClock implements Clock {
  now(): number {
    return performance.now();
  }

  wallNow(): number {
    return Date.now();
  }

  sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("Operation aborted."));
        return;
      }
      const handle = setTimeout(resolve, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(handle);
          reject(signal.reason ?? new Error("Operation aborted."));
        },
        { once: true },
      );
    });
  }
}

export class OutputEngine {
  readonly #outputs = new Map<string, OutputState>();
  readonly #pendingMutations = new Set<string>();
  readonly #transport: OutputTransport;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #activeIntervalMs: number;
  readonly #defaultIdleFps: number;
  readonly #sendTimeoutMs: number;
  readonly #shutdownTimeoutMs: number;
  readonly #maxOutputs: number;
  readonly #closeTransport: boolean;
  readonly #createId: () => string;
  readonly #lifecycle = new AbortController();
  #running = false;
  #closed = false;
  #loopPromise: Promise<void> | null = null;
  #wake: (() => void) | null = null;
  #loopIterations = 0;
  #lastLoopStartedAt: number | null = null;
  #lastLoopCompletedAt: number | null = null;
  readonly #transportTelemetry = {
    sendAttempts: 0,
    sendFailures: 0,
    sendRetries: 0,
    sendSuccesses: 0,
    sendTimeouts: 0,
  };

  constructor(options: OutputEngineOptions) {
    const activeFps = options.activeFps ?? DEFAULT_ACTIVE_FPS;
    const idleFps = options.idleFps ?? DEFAULT_IDLE_FPS;
    const sendTimeoutMs = options.sendTimeoutMs ?? 1000;
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2000;
    const maxOutputs = options.maxOutputs ?? 1024;
    assertFps(activeFps, "Active FPS");
    assertFps(idleFps, "Idle FPS");
    assertTimeout(sendTimeoutMs);
    assertTimeout(shutdownTimeoutMs);
    if (!Number.isInteger(maxOutputs) || maxOutputs < 1) {
      throw new SacnLifecycleError(
        "Maximum outputs must be a positive integer.",
      );
    }
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#activeIntervalMs = 1000 / activeFps;
    this.#defaultIdleFps = idleFps;
    this.#sendTimeoutMs = sendTimeoutMs;
    this.#shutdownTimeoutMs = shutdownTimeoutMs;
    this.#maxOutputs = maxOutputs;
    this.#closeTransport = options.closeTransport ?? true;
    this.#createId = options.createId;
  }

  restore(record: OutputRecord): void {
    this.#assertOpen();
    const address = normalizeAddress(record);
    assertFps(record.idleFps, "Idle FPS");
    if (this.#outputs.has(this.#key(address))) return;
    if (this.#outputs.size >= this.#maxOutputs) {
      throw new SacnLifecycleError(
        `Output limit of ${this.#maxOutputs} has been reached while restoring state.`,
      );
    }
    const state = this.#createState(record, toValidatedFrame(record.target));
    this.#outputs.set(this.#key(address), state);
  }

  async beginMutation(
    addressInput: OutputAddress,
  ): Promise<OutputMutationCheckpoint> {
    this.#assertOpen();
    const address = normalizeAddress(addressInput);
    const key = this.#key(address);
    if (this.#pendingMutations.has(key)) {
      throw new SacnLifecycleError(`Output ${key} already has a pending mutation.`);
    }
    const output = this.#outputs.get(key);
    if (output?.sending) await output.sending;
    if (output?.transportPending) await output.transportPending;
    this.#pendingMutations.add(key);
    return {
      key,
      state: output ? this.#cloneState(output) : null,
    };
  }

  commitMutation(checkpoint: OutputMutationCheckpoint): void {
    this.#pendingMutations.delete(checkpoint.key);
    this.#wakeLoop();
  }

  rollbackMutation(checkpoint: OutputMutationCheckpoint): void {
    if (checkpoint.state) {
      this.#outputs.set(checkpoint.key, checkpoint.state);
    } else {
      this.#outputs.delete(checkpoint.key);
    }
    this.#pendingMutations.delete(checkpoint.key);
    this.#wakeLoop();
  }

  start(): void {
    this.#assertOpen();
    if (this.#running) return;
    this.#running = true;
    this.#loopPromise = this.#loop();
    this.#logger.info?.("Output engine started.", {
      activeFrameIntervalMs: this.#activeIntervalMs,
      idleFps: this.#defaultIdleFps,
    });
  }

  /**
   * Pauses the scheduler without tearing down outputs or the transport.
   * `start()` can resume the loop afterward.
   */
  async stop(): Promise<void> {
    this.#assertOpen();
    if (!this.#running) return;
    this.#running = false;
    this.#wakeLoop();
    if (this.#loopPromise) {
      await this.#loopPromise;
      this.#loopPromise = null;
    }
    this.#logger.info?.("Output engine stopped.");
  }

  writeFrame(
    options: OutputOptions,
    frame: Uint8Array,
    durationMs: number,
  ): OutputSnapshot {
    this.#assertOpen();
    assertFade(durationMs);
    const output = this.#getOrCreate(options);
    const now = this.#clock.now();
    this.#updateTransitions(output, now);
    if (durationMs === 0) {
      output.current.set(frame);
      output.target.set(frame);
      output.transitions.clear();
    } else {
      for (let index = 0; index < SLOT_COUNT; index += 1) {
        const target = frame[index] ?? 0;
        if (target === output.current[index]) {
          output.target[index] = target;
          output.transitions.delete(index);
        } else {
          output.target[index] = target;
          output.transitions.set(index, {
            from: output.current[index] ?? 0,
            to: target,
            startedAt: now,
            durationMs,
          });
        }
      }
    }
    this.#markChanged(output, now);
    return this.#snapshot(output);
  }

  writeChannels(
    options: OutputOptions,
    writes: readonly ChannelWrite[],
  ): OutputSnapshot {
    this.#assertOpen();
    validateChannelWrites(writes);
    const output = this.#getOrCreate(options);
    const now = this.#clock.now();
    this.#updateTransitions(output, now);
    for (const write of writes) {
      const index = write.channel - 1;
      const durationMs = write.durationMs ?? 0;
      const from = output.current[index] ?? 0;
      output.target[index] = write.value;
      if (durationMs === 0 || from === write.value) {
        output.current[index] = write.value;
        output.transitions.delete(index);
      } else {
        output.transitions.set(index, {
          from,
          to: write.value,
          startedAt: now,
          durationMs,
        });
      }
    }
    this.#markChanged(output, now);
    return this.#snapshot(output);
  }

  getOutput(addressInput: OutputAddress): OutputSnapshot | null {
    this.#assertOpen();
    const address = normalizeAddress(addressInput);
    const output = this.#outputs.get(this.#key(address));
    if (!output) return null;
    this.#updateTransitions(output, this.#clock.now());
    return this.#snapshot(output);
  }

  listOutputs(): readonly OutputSnapshot[] {
    this.#assertOpen();
    const now = this.#clock.now();
    return Object.freeze(
      [...this.#outputs.values()]
        .sort(
          (left, right) =>
            left.address.universe - right.address.universe ||
            left.address.priority - right.address.priority,
        )
        .map((output) => {
          this.#updateTransitions(output, now);
          return this.#snapshot(output);
        }),
    );
  }

  async clearOutput(addressInput: OutputAddress): Promise<boolean> {
    this.#assertOpen();
    const address = normalizeAddress(addressInput);
    const output = this.#outputs.get(this.#key(address));
    if (!output) return false;
    if (output.sending) await output.sending;
    if (output.transportPending) await output.transportPending;
    const now = this.#clock.now();
    output.current.fill(0);
    output.target.fill(0);
    output.transitions.clear();
    this.#markChanged(output, now);
    const sent = await this.#beginSend(output, now);
    if (!sent) {
      throw new TransportError(
        `Failed to send blackout frame for ${this.#key(address)}.`,
      );
    }
    this.#outputs.delete(this.#key(address));
    try {
      await this.#transport.closeOutput?.(address);
    } catch (error) {
      throw new TransportError(`Failed to close output ${this.#key(address)}.`, error);
    }
    this.#wakeLoop();
    return true;
  }

  getTelemetry(): EngineTelemetry {
    const outputs = this.#closed
      ? Object.freeze([] as OutputSnapshot[])
      : this.listOutputs();
    return Object.freeze({
      closed: this.#closed,
      running: this.#running,
      outputCount: outputs.length,
      outputs,
      loopIterations: this.#loopIterations,
      lastLoopStartedAt: this.#lastLoopStartedAt,
      lastLoopCompletedAt: this.#lastLoopCompletedAt,
      lastLoopDurationMs:
        this.#lastLoopStartedAt !== null &&
        this.#lastLoopCompletedAt !== null
          ? Math.max(
              0,
              this.#lastLoopCompletedAt - this.#lastLoopStartedAt,
            )
          : null,
      transport: Object.freeze({ ...this.#transportTelemetry }),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#running = false;
    this.#lifecycle.abort(new SacnLifecycleError("Output engine closed."));
    this.#wakeLoop();
    if (this.#loopPromise) {
      await this.#loopPromise;
      this.#loopPromise = null;
    }
    await Promise.allSettled(
      [...this.#outputs.values()]
        .map((output) => output.sending)
        .filter((send): send is Promise<boolean> => send !== null),
    );
    if (this.#closeTransport) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#transport.close(),
          new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(
              () =>
                reject(
                  new TransportError(
                    `Transport close timed out after ${this.#shutdownTimeoutMs}ms.`,
                  ),
                ),
              this.#shutdownTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    }
    this.#outputs.clear();
    this.#logger.info?.("Output engine closed.");
  }

  #getOrCreate(options: OutputOptions): OutputState {
    const address = normalizeAddress(options);
    const key = this.#key(address);
    const existing = this.#outputs.get(key);
    if (existing) {
      this.#applyOptions(existing, options);
      return existing;
    }
    if (this.#outputs.size >= this.#maxOutputs) {
      throw new SacnLifecycleError(
        `Output limit of ${this.#maxOutputs} has been reached.`,
      );
    }
    const now = this.#clock.now();
    const state = this.#createState(
      {
        ...address,
        cid: options.cid ?? this.#createId(),
        idleFps: options.idleFps ?? this.#defaultIdleFps,
        sourceName: options.sourceName ?? null,
        target: Array.from({ length: SLOT_COUNT }, () => 0),
        updatedAt: this.#wallNow(),
      },
      new Uint8Array(SLOT_COUNT),
    );
    this.#applyOptions(state, options);
    this.#outputs.set(key, state);
    return state;
  }

  #createState(record: OutputRecord, frame: Uint8Array): OutputState {
    if (frame.length !== SLOT_COUNT) {
      throw new Error(`Stored frame must contain exactly ${SLOT_COUNT} values.`);
    }
    return {
      address: normalizeAddress(record),
      cid: assertCid(record.cid),
      idleFps: record.idleFps,
      sourceName:
        record.sourceName === null ? null : assertSourceName(record.sourceName),
      current: frame.slice(),
      target: frame.slice(),
      lastSent: new Uint8Array(SLOT_COUNT),
      transitions: new Map(),
      sequence: 0,
      lastSentAt: null,
      nextDueAt: this.#clock.now(),
      dirty: true,
      lastError: null,
      consecutiveFailures: 0,
      updatedAt: record.updatedAt,
      revision: 0,
      sending: null,
      transportPending: null,
    };
  }

  #applyOptions(output: OutputState, options: OutputOptions): void {
    const cid =
      options.cid === undefined ? output.cid : assertCid(options.cid);
    const idleFps = options.idleFps ?? output.idleFps;
    if (options.idleFps !== undefined) {
      assertFps(options.idleFps, "Idle FPS");
    }
    const sourceName =
      options.sourceName === undefined
        ? output.sourceName
        : assertSourceName(options.sourceName);
    output.cid = cid;
    output.idleFps = idleFps;
    output.sourceName = sourceName;
  }

  #markChanged(output: OutputState, now: number): void {
    output.dirty = true;
    output.lastError = null;
    output.nextDueAt = now;
    output.updatedAt = this.#wallNow();
    output.revision += 1;
    this.#wakeLoop();
  }

  #updateTransitions(output: OutputState, now: number): boolean {
    let active = false;
    for (const [index, transition] of output.transitions) {
      const elapsed = now - transition.startedAt;
      if (elapsed >= transition.durationMs) {
        output.current[index] = transition.to;
        output.transitions.delete(index);
        continue;
      }
      const progress = Math.max(0, elapsed / transition.durationMs);
      output.current[index] = Math.round(
        transition.from + (transition.to - transition.from) * progress,
      );
      active = true;
    }
    return active;
  }

  #mode(output: OutputState): FrameMode {
    return output.dirty ||
      output.transitions.size > 0 ||
      !framesEqual(output.current, output.lastSent)
      ? "active"
      : "idle";
  }

  #interval(output: OutputState): number {
    return this.#mode(output) === "active"
      ? this.#activeIntervalMs
      : 1000 / output.idleFps;
  }

  #snapshot(output: OutputState): OutputSnapshot {
    return Object.freeze({
      universe: output.address.universe,
      priority: output.address.priority,
      cid: output.cid,
      sourceName: output.sourceName,
      idleFps: output.idleFps,
      current: frozenFrame(output.current),
      target: frozenFrame(output.target),
      lastSent: frozenFrame(output.lastSent),
      activeTransitions: output.transitions.size,
      frameMode: this.#mode(output),
      dirty: output.dirty,
      sequence: output.sequence,
      lastSentAt: output.lastSentAt,
      nextDueAt: output.nextDueAt,
      lastError: output.lastError,
      updatedAt: output.updatedAt,
    });
  }

  async #loop(): Promise<void> {
    while (this.#running && !this.#lifecycle.signal.aborted) {
      const now = this.#clock.now();
      this.#lastLoopStartedAt = now;
      this.#loopIterations += 1;
      const sends: Promise<boolean>[] = [];
      for (const output of this.#outputs.values()) {
        if (this.#pendingMutations.has(this.#key(output.address))) continue;
        this.#updateTransitions(output, now);
        if (
          !output.sending &&
          !output.transportPending &&
          (output.dirty || now >= output.nextDueAt)
        ) {
          sends.push(this.#beginSend(output, now));
        }
      }
      await Promise.allSettled(sends);
      this.#lastLoopCompletedAt = this.#clock.now();
      if (!this.#running) break;
      let nextDueAt = Number.POSITIVE_INFINITY;
      for (const output of this.#outputs.values()) {
        if (this.#pendingMutations.has(this.#key(output.address))) continue;
        nextDueAt = Math.min(nextDueAt, output.nextDueAt);
      }
      const delay = Number.isFinite(nextDueAt)
        ? Math.max(1, nextDueAt - this.#clock.now())
        : 1000;
      await this.#wait(delay);
    }
  }

  #beginSend(output: OutputState, now: number): Promise<boolean> {
    const send = this.#send(output, now);
    output.sending = send;
    void send.finally(() => {
      if (output.sending === send) output.sending = null;
    });
    return send;
  }

  async #send(output: OutputState, now: number): Promise<boolean> {
    const revision = output.revision;
    const wasTransitioning = output.transitions.size > 0;
    const sentFrame = output.current.slice();
    const packet: OutputPacket = Object.freeze({
      cid: output.cid,
      universe: output.address.universe,
      priority: output.address.priority,
      sequence: output.sequence,
      sourceName: output.sourceName,
      data: sentFrame.slice(),
    });
    if (output.consecutiveFailures > 0) {
      this.#transportTelemetry.sendRetries += 1;
    }
    this.#transportTelemetry.sendAttempts += 1;
    try {
      await this.#sendWithTimeout(packet, output);
      output.lastSent.set(sentFrame);
      output.lastSentAt = now;
      output.sequence = (output.sequence + 1) & 0xff;
      output.dirty = output.revision !== revision;
      output.lastError = null;
      output.consecutiveFailures = 0;
      output.nextDueAt =
        now +
        (wasTransitioning ? this.#activeIntervalMs : this.#interval(output));
      this.#transportTelemetry.sendSuccesses += 1;
      return true;
    } catch (error) {
      if (this.#closed) return false;
      output.lastError = errorMessage(error);
      output.dirty = true;
      output.consecutiveFailures += 1;
      const retryDelayMs = Math.min(
        5000,
        this.#activeIntervalMs * 2 ** Math.min(output.consecutiveFailures - 1, 8),
      );
      output.nextDueAt = now + retryDelayMs;
      this.#transportTelemetry.sendFailures += 1;
      if (error instanceof TransportTimeoutError) {
        this.#transportTelemetry.sendTimeouts += 1;
      }
      this.#logger.error?.("Output transport send failed.", {
        universe: output.address.universe,
        priority: output.address.priority,
        error: output.lastError,
      });
      return false;
    }
  }

  async #sendWithTimeout(
    packet: OutputPacket,
    output: OutputState,
  ): Promise<void> {
    const sendController = new AbortController();
    const timeoutController = new AbortController();
    let rejectOnClose: ((reason: unknown) => void) | undefined;
    const closed = new Promise<never>((_resolve, reject) => {
      rejectOnClose = reject;
    });
    const onClose = (): void => {
      const reason =
        this.#lifecycle.signal.reason ??
        new SacnLifecycleError("Output engine closed.");
      sendController.abort(reason);
      rejectOnClose?.(reason);
    };
    this.#lifecycle.signal.addEventListener("abort", onClose, { once: true });
    const timeoutError = new TransportTimeoutError(
      this.#sendTimeoutMs,
      packet.universe,
      packet.priority,
    );
    const timeout = this.#clock
      .sleep(this.#sendTimeoutMs, timeoutController.signal)
      .then(() => {
        sendController.abort(timeoutError);
        throw timeoutError;
      });
    const transportSend = Promise.resolve()
      .then(() => this.#transport.send(packet, sendController.signal))
      .catch((error: unknown) => {
        if (error instanceof TransportTimeoutError) throw error;
        if (this.#lifecycle.signal.aborted) throw error;
        throw new TransportError(
          `Transport send failed for output ${packet.universe}:${packet.priority}.`,
          error,
        );
      });
    const settlement = transportSend.then(
      () => undefined,
      () => undefined,
    );
    output.transportPending = settlement;
    void settlement.finally(() => {
      if (output.transportPending === settlement) {
        output.transportPending = null;
        this.#wakeLoop();
      }
    });
    try {
      await Promise.race([
        transportSend,
        timeout,
        closed,
      ]);
    } finally {
      timeoutController.abort();
      this.#lifecycle.signal.removeEventListener("abort", onClose);
    }
  }

  async #wait(delayMs: number): Promise<void> {
    const controller = new AbortController();
    const onClose = (): void => controller.abort(this.#lifecycle.signal.reason);
    this.#lifecycle.signal.addEventListener("abort", onClose, { once: true });
    const wake = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    try {
      await Promise.race([
        this.#clock.sleep(delayMs, controller.signal),
        wake,
      ]);
    } catch {
      // Closing the engine aborts the scheduler wait.
    } finally {
      this.#wake = null;
      controller.abort();
      this.#lifecycle.signal.removeEventListener("abort", onClose);
    }
  }

  #wakeLoop(): void {
    this.#wake?.();
  }

  #key(address: Required<OutputAddress>): string {
    return `${address.universe}:${address.priority}`;
  }

  #cloneState(output: OutputState): OutputState {
    return {
      ...output,
      address: Object.freeze({ ...output.address }),
      current: output.current.slice(),
      target: output.target.slice(),
      lastSent: output.lastSent.slice(),
      transitions: new Map(
        [...output.transitions].map(([index, transition]) => [
          index,
          { ...transition },
        ]),
      ),
      sending: null,
      transportPending: null,
    };
  }

  #wallNow(): number {
    return this.#clock.wallNow?.() ?? Date.now();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SacnLifecycleError("Output engine is closed.");
    }
  }
}
