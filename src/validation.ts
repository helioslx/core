import {
  DEFAULT_PRIORITY,
  MAX_PRIORITY,
  MAX_UNIVERSE,
  MIN_PRIORITY,
  MIN_UNIVERSE,
  SLOT_COUNT,
  type ChannelValues,
  type ChannelWrite,
  type OutputAddress,
  type TransitionWrite,
} from "./contracts.js";

export type ValidationCode =
  | "INVALID_CHANNEL"
  | "INVALID_CID"
  | "INVALID_FADE"
  | "INVALID_FPS"
  | "INVALID_FRAME"
  | "INVALID_PRIORITY"
  | "INVALID_PORT"
  | "INVALID_NAMESPACE"
  | "INVALID_SOURCE_NAME"
  | "INVALID_TIMEOUT"
  | "INVALID_UNIVERSE";

export class SacnError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

export class SacnValidationError extends SacnError {
  constructor(message: string, code: ValidationCode) {
    super(message, code);
  }
}

export class SacnLifecycleError extends SacnError {
  constructor(message: string) {
    super(message, "INVALID_LIFECYCLE");
  }
}

export class TransportTimeoutError extends SacnError {
  constructor(timeoutMs: number, universe: number, priority: number) {
    super(
      `Transport send timed out after ${timeoutMs}ms for output ${universe}:${priority}.`,
      "TRANSPORT_TIMEOUT",
    );
  }
}

export class TransportError extends SacnError {
  constructor(message: string, cause?: unknown) {
    super(message, "TRANSPORT_ERROR", cause);
  }
}

export class PersistenceError extends SacnError {
  constructor(message: string, cause?: unknown) {
    super(message, "PERSISTENCE_ERROR", cause);
  }
}

export class DependencyUnavailableError extends SacnError {
  constructor(message: string, cause?: unknown) {
    super(message, "DEPENDENCY_UNAVAILABLE", cause);
  }
}

const integerInRange = (
  value: number,
  minimum: number,
  maximum: number,
  label: string,
  code: ValidationCode,
): void => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SacnValidationError(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
      code,
    );
  }
};

export const normalizeAddress = (
  address: OutputAddress,
): Required<OutputAddress> => {
  if (!address || typeof address !== "object") {
    throw new SacnValidationError(
      "Output address must be an object.",
      "INVALID_UNIVERSE",
    );
  }
  integerInRange(
    address.universe,
    MIN_UNIVERSE,
    MAX_UNIVERSE,
    "Universe",
    "INVALID_UNIVERSE",
  );
  const priority = address.priority ?? DEFAULT_PRIORITY;
  integerInRange(
    priority,
    MIN_PRIORITY,
    MAX_PRIORITY,
    "Priority",
    "INVALID_PRIORITY",
  );
  return { universe: address.universe, priority };
};

export const assertFps = (value: number, label = "FPS"): void => {
  if (!Number.isFinite(value) || value <= 0 || value > 1000) {
    throw new SacnValidationError(
      `${label} must be a finite number greater than 0 and at most 1000.`,
      "INVALID_FPS",
    );
  }
};

export const assertTimeout = (value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SacnValidationError(
      "Send timeout must be a finite number greater than 0.",
      "INVALID_TIMEOUT",
    );
  }
};

export const assertPort = (value: number): void => {
  integerInRange(value, 1, 65_535, "UDP port", "INVALID_PORT");
};

export const assertFade = (value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new SacnValidationError(
      "Fade duration must be a finite number greater than or equal to 0.",
      "INVALID_FADE",
    );
  }
};

/** @deprecated Prefer assertFade; kept as a clearer alias for durationMs APIs. */
export const assertDuration = assertFade;

export const assertSourceName = (value: string): string => {
  if (typeof value !== "string") {
    throw new SacnValidationError(
      "Source name must be a string.",
      "INVALID_SOURCE_NAME",
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 64) {
    throw new SacnValidationError(
      "Source name must contain between 1 and 64 characters.",
      "INVALID_SOURCE_NAME",
    );
  }
  return normalized;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const assertCid = (value: string): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SacnValidationError("CID must be a valid UUID.", "INVALID_CID");
  }
  return value.toLowerCase();
};

export const assertChannelWrite = (write: ChannelWrite): void => {
  if (!write || typeof write !== "object") {
    throw new SacnValidationError(
      "Each channel write must be an object.",
      "INVALID_CHANNEL",
    );
  }
  integerInRange(write.channel, 1, SLOT_COUNT, "Channel", "INVALID_CHANNEL");
  integerInRange(write.value, 0, 255, "Channel value", "INVALID_CHANNEL");
  if (write.durationMs !== undefined) assertFade(write.durationMs);
};

export const validateChannelWrites = (
  writes: readonly ChannelWrite[],
): void => {
  if (!Array.isArray(writes)) {
    throw new SacnValidationError(
      "Channel writes must be an array.",
      "INVALID_CHANNEL",
    );
  }
  if (writes.length === 0) {
    throw new SacnValidationError(
      "At least one channel write is required.",
      "INVALID_CHANNEL",
    );
  }
  const seen = new Set<number>();
  for (const write of writes) {
    assertChannelWrite(write);
    if (seen.has(write.channel)) {
      throw new SacnValidationError(
        `Channel ${write.channel} appears more than once.`,
        "INVALID_CHANNEL",
      );
    }
    seen.add(write.channel);
  }
};

export const assertTransitionWrite = (write: TransitionWrite): void => {
  if (!write || typeof write !== "object") {
    throw new SacnValidationError(
      "Each transition write must be an object.",
      "INVALID_CHANNEL",
    );
  }
  integerInRange(write.channel, 1, SLOT_COUNT, "Channel", "INVALID_CHANNEL");
  integerInRange(write.value, 0, 255, "Channel value", "INVALID_CHANNEL");
  assertFade(write.durationMs);
};

export const validateTransitionWrites = (
  writes: readonly TransitionWrite[],
): void => {
  if (!Array.isArray(writes)) {
    throw new SacnValidationError(
      "Transition writes must be an array.",
      "INVALID_CHANNEL",
    );
  }
  if (writes.length === 0) {
    throw new SacnValidationError(
      "At least one transition write is required.",
      "INVALID_CHANNEL",
    );
  }
  const seen = new Set<number>();
  for (const write of writes) {
    assertTransitionWrite(write);
    if (seen.has(write.channel)) {
      throw new SacnValidationError(
        `Channel ${write.channel} appears more than once.`,
        "INVALID_CHANNEL",
      );
    }
    seen.add(write.channel);
  }
};

export const channelValuesToWrites = (
  values: ChannelValues,
  durationMs?: number,
): ChannelWrite[] => {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new SacnValidationError(
      "Channel values must be an object map.",
      "INVALID_CHANNEL",
    );
  }
  if (durationMs !== undefined) assertFade(durationMs);
  const writes: ChannelWrite[] = [];
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const channel = Number(rawKey);
    if (!Number.isInteger(channel) || String(channel) !== rawKey) {
      throw new SacnValidationError(
        `Channel key "${rawKey}" must be an integer between 1 and ${SLOT_COUNT}.`,
        "INVALID_CHANNEL",
      );
    }
    if (typeof rawValue !== "number") {
      throw new SacnValidationError(
        `Channel ${channel} value must be a number.`,
        "INVALID_CHANNEL",
      );
    }
    writes.push({
      channel,
      value: rawValue,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }
  validateChannelWrites(writes);
  return writes;
};

export const toValidatedFrame = (
  values: readonly number[] | Uint8Array,
): Uint8Array => {
  if (!Array.isArray(values) && !(values instanceof Uint8Array)) {
    throw new SacnValidationError(
      "Frame values must be an array or Uint8Array.",
      "INVALID_FRAME",
    );
  }
  if (values.length !== SLOT_COUNT) {
    throw new SacnValidationError(
      `Frame must contain exactly ${SLOT_COUNT} values.`,
      "INVALID_FRAME",
    );
  }
  const frame = new Uint8Array(SLOT_COUNT);
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const value = values[index];
    if (
      value === undefined ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 255
    ) {
      throw new SacnValidationError(
        `Frame value at channel ${index + 1} must be an integer between 0 and 255.`,
        "INVALID_FRAME",
      );
    }
    frame[index] = value;
  }
  return frame;
};
