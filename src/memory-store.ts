import type {
  OutputAddress,
  OutputRecord,
  OutputStore,
} from "./contracts.js";

const keyOf = ({ universe, priority }: Required<OutputAddress>): string =>
  `${universe}:${priority}`;

const cloneRecord = (record: OutputRecord): OutputRecord =>
  Object.freeze({
    ...record,
    target: Object.freeze([...record.target]),
  });

export class MemoryOutputStore implements OutputStore {
  readonly #records = new Map<string, OutputRecord>();

  async get(address: Required<OutputAddress>): Promise<OutputRecord | null> {
    const record = this.#records.get(keyOf(address));
    return record ? cloneRecord(record) : null;
  }

  async list(): Promise<readonly OutputRecord[]> {
    return Object.freeze(
      [...this.#records.values()]
        .sort(
          (left, right) =>
            left.universe - right.universe || left.priority - right.priority,
        )
        .map(cloneRecord),
    );
  }

  async remove(address: Required<OutputAddress>): Promise<void> {
    this.#records.delete(keyOf(address));
  }

  async save(record: OutputRecord): Promise<void> {
    this.#records.set(
      keyOf({ universe: record.universe, priority: record.priority }),
      cloneRecord(record),
    );
  }
}
