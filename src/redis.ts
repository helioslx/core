import { createClient } from "redis";
import {
  type OutputAddress,
  type OutputRecord,
  type OutputStore,
  type ViewerRecord,
  type ViewerStore,
} from "./contracts.js";
import {
  PersistenceError,
  SacnValidationError,
  assertCid,
  assertFps,
  assertSourceName,
  normalizeAddress,
  toValidatedFrame,
} from "./validation.js";

export interface RedisClientCompatible {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  scanIterator(options: {
    MATCH: string;
    COUNT?: number;
  }): AsyncIterable<string | string[]>;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): unknown;
}

export interface RedisStoreOptions {
  readonly client?: RedisClientCompatible;
  readonly url?: string;
  readonly namespace?: string;
  readonly version?: string | number;
  /** Defaults to true for an internally-created client and false for an injected client. */
  readonly closeClient?: boolean;
}

abstract class RedisStoreBase {
  readonly prefix: string;
  readonly #client: Promise<RedisClientCompatible>;
  readonly #closeClient: boolean;
  #queue: Promise<void> = Promise.resolve();
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: RedisStoreOptions) {
    const namespace = options.namespace ?? "helioslx";
    const version = String(options.version ?? 1);
    if (
      !/^[A-Za-z0-9:_-]{1,128}$/.test(namespace) ||
      !/^[A-Za-z0-9._-]{1,32}$/.test(version)
    ) {
      throw new SacnValidationError(
        "Redis namespace or schema version contains unsupported characters.",
        "INVALID_NAMESPACE",
      );
    }
    this.prefix = `${namespace}:v${version}`;
    this.#closeClient = options.closeClient ?? options.client === undefined;
    if (options.client) {
      this.#client = Promise.resolve(options.client);
    } else {
      const client = createClient(options.url ? { url: options.url } : {});
      this.#client = client.connect().then(() => client as RedisClientCompatible);
    }
  }

  protected ordered<T>(action: string, operation: (client: RedisClientCompatible) => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) {
      return Promise.reject(new PersistenceError("Redis store is closed."));
    }
    const result = this.#queue.then(async () => {
      try {
        return await operation(await this.#client);
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError(`Redis failed to ${action}.`, error);
      }
    });
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#queue.then(async () => {
      try {
        if (this.#closeClient) {
          const client = await this.#client;
          if (client.quit) await client.quit();
          else client.disconnect?.();
        }
      } catch (error) {
        throw new PersistenceError("Redis failed to close client.", error);
      } finally {
        this.#closed = true;
        this.#closing = false;
      }
    });
    return this.#closePromise;
  }
}

const outputRecord = (value: unknown): OutputRecord => {
  if (!value || typeof value !== "object") {
    throw new PersistenceError("Stored Redis output record is not an object.");
  }
  const record = value as Record<string, unknown>;
  const address = normalizeAddress({
    universe: record.universe as number,
    priority: record.priority as number,
  });
  const cid = assertCid(record.cid as string);
  assertFps(record.idleFps as number, "Idle FPS");
  const sourceName =
    record.sourceName === null ? null : assertSourceName(record.sourceName as string);
  const target = toValidatedFrame(record.target as number[]);
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) {
    throw new PersistenceError("Stored Redis output updatedAt is invalid.");
  }
  return Object.freeze({
    ...address,
    cid,
    idleFps: record.idleFps as number,
    sourceName,
    target: Object.freeze(Array.from(target)),
    updatedAt: record.updatedAt,
  });
};

const validateOutputRecord = (value: unknown): OutputRecord => {
  try {
    return outputRecord(value);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("Redis output record is invalid.", error);
  }
};

export class RedisOutputStore extends RedisStoreBase implements OutputStore {
  constructor(options: RedisStoreOptions = {}) {
    super(options);
  }

  #key(address: Required<OutputAddress>): string {
    return `${this.prefix}:output:${address.universe}:${address.priority}`;
  }

  get(address: Required<OutputAddress>): Promise<OutputRecord | null> {
    return this.ordered("get output", async (client) => {
      const value = await client.get(this.#key(address));
      return value === null ? null : validateOutputRecord(JSON.parse(value));
    });
  }

  list(): Promise<readonly OutputRecord[]> {
    return this.ordered("list outputs", async (client) => {
      const pattern = `${this.prefix}:output:*`;
      const keys: string[] = [];
      for await (const entry of client.scanIterator({
        MATCH: pattern,
        COUNT: 100,
      })) {
        if (Array.isArray(entry)) keys.push(...entry);
        else keys.push(entry);
      }
      const records = await Promise.all(
        keys.sort().map(async (key) => {
          const value = await client.get(key);
          if (value === null) {
            throw new PersistenceError(`Redis output key disappeared: ${key}.`);
          }
          return validateOutputRecord(JSON.parse(value));
        }),
      );
      return Object.freeze(
        records.sort(
          (left, right) =>
            left.universe - right.universe || left.priority - right.priority,
        ),
      );
    });
  }

  remove(address: Required<OutputAddress>): Promise<void> {
    return this.ordered("remove output", async (client) => {
      await client.del(this.#key(address));
    });
  }

  save(record: OutputRecord): Promise<void> {
    const validated = validateOutputRecord(record);
    return this.ordered("save output", async (client) => {
      await client.set(
        this.#key({ universe: validated.universe, priority: validated.priority }),
        JSON.stringify(validated),
      );
    });
  }
}

const viewerRecord = (value: unknown): ViewerRecord => {
  if (!value || typeof value !== "object") {
    throw new PersistenceError("Stored Redis viewer record is not an object.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.selectedUniverses)) {
    throw new PersistenceError("Stored Redis viewer universes are invalid.");
  }
  const universes = [...new Set(record.selectedUniverses)].map((universe) => {
    const normalized = normalizeAddress({ universe: universe as number });
    return normalized.universe;
  });
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) {
    throw new PersistenceError("Stored Redis viewer updatedAt is invalid.");
  }
  return Object.freeze({
    selectedUniverses: Object.freeze(universes.sort((a, b) => a - b)),
    updatedAt: record.updatedAt,
  });
};

const validateViewerRecord = (value: unknown): ViewerRecord => {
  try {
    return viewerRecord(value);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError("Redis viewer record is invalid.", error);
  }
};

export class RedisViewerStore extends RedisStoreBase implements ViewerStore {
  readonly #key: string;

  constructor(options: RedisStoreOptions = {}) {
    super(options);
    this.#key = `${this.prefix}:viewer`;
  }

  load(): Promise<ViewerRecord | null> {
    return this.ordered("load viewer state", async (client) => {
      const value = await client.get(this.#key);
      return value === null ? null : validateViewerRecord(JSON.parse(value));
    });
  }

  save(record: ViewerRecord): Promise<void> {
    const validated = validateViewerRecord(record);
    return this.ordered("save viewer state", async (client) => {
      await client.set(this.#key, JSON.stringify(validated));
    });
  }
}
