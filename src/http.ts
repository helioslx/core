import { Elysia, t } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { node } from "@elysiajs/node";
import {
  SLOT_COUNT,
  type ChannelValues,
  type ChannelWrite,
  type SacnSourceContract,
  type TransitionWrite,
  type UniverseContract,
  type ViewerPacket,
  type ViewerServiceContract,
} from "./contracts.js";
import {
  DependencyUnavailableError,
  PersistenceError,
  SacnLifecycleError,
  SacnValidationError,
  TransportError,
} from "./validation.js";

export interface HttpAuthContext {
  readonly request: Request;
}

export type HttpAuthHook = (
  context: HttpAuthContext,
) => boolean | Response | void | Promise<boolean | Response | void>;

export interface SacnHttpAdapterOptions {
  readonly source: SacnSourceContract;
  readonly viewer?: ViewerServiceContract;
  /** Defaults to `/sacn`. */
  readonly prefix?: string;
  /** Authentication hook; returning false produces 401, and Response is forwarded. */
  readonly auth?: HttpAuthHook;
  /** Called for every normalized viewer packet; useful for WebSocket/SSE bridges. */
  readonly onViewerPacket?: (packet: ViewerPacket) => void;
  /** Value used by deprecated compatibility routes. */
  readonly sunset?: string;
  /** OpenAPI document path. Defaults to `/openapi`. */
  readonly openapiPath?: string;
  /** Maximum concurrent viewer WebSocket clients. Defaults to 64. */
  readonly maxWebSocketClients?: number;
  /** Coalesced packet queue per WebSocket client. Defaults to 32 universes. */
  readonly webSocketQueueCapacity?: number;
}

interface RouteSet {
  headers: Record<string, string | number>;
  status?: number | string;
}

interface OutputParams {
  universe: string;
  priority: string;
}

const outputParamsSchema = t.Object({
  universe: t.String({ pattern: "^-?\\d+$" }),
  priority: t.String({ pattern: "^-?\\d+$" }),
});
const frameValuesSchema = t.Array(t.Integer({ minimum: 0, maximum: 255 }), {
  minItems: SLOT_COUNT,
  maxItems: SLOT_COUNT,
});
const outputOptionsSchema = {
  cid: t.Optional(t.String()),
  idleFps: t.Optional(t.Number({ exclusiveMinimum: 0, maximum: 1000 })),
  sourceName: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
};
const frameBodySchema = t.Object({
  values: frameValuesSchema,
  durationMs: t.Optional(t.Number({ minimum: 0 })),
  ...outputOptionsSchema,
});
const upsertBodySchema = t.Object({
  initialValues: t.Optional(frameValuesSchema),
  values: t.Optional(frameValuesSchema),
  durationMs: t.Optional(t.Number({ minimum: 0 })),
  ...outputOptionsSchema,
});
const channelWritesSchema = t.Array(
  t.Object({
    channel: t.Integer({ minimum: 1, maximum: SLOT_COUNT }),
    value: t.Integer({ minimum: 0, maximum: 255 }),
    durationMs: t.Optional(t.Number({ minimum: 0 })),
  }),
  { minItems: 1 },
);
const channelsBodySchema = t.Union([
  t.Object({
    channels: t.Union([
      channelWritesSchema,
      t.Record(t.String(), t.Integer({ minimum: 0, maximum: 255 })),
    ]),
    durationMs: t.Optional(t.Number({ minimum: 0 })),
    ...outputOptionsSchema,
  }),
  t.Object({
    changes: channelWritesSchema,
    durationMs: t.Optional(t.Number({ minimum: 0 })),
    ...outputOptionsSchema,
  }),
]);
const outputSnapshotSchema = t.Object({
  activeTransitions: t.Integer({ minimum: 0 }),
  cid: t.String(),
  current: frameValuesSchema,
  dirty: t.Boolean(),
  frameMode: t.Union([t.Literal("active"), t.Literal("idle")]),
  idleFps: t.Number(),
  lastError: t.Union([t.String(), t.Null()]),
  lastSent: frameValuesSchema,
  lastSentAt: t.Union([t.Number(), t.Null()]),
  nextDueAt: t.Number(),
  priority: t.Integer(),
  sequence: t.Integer(),
  sourceName: t.Union([t.String(), t.Null()]),
  target: frameValuesSchema,
  universe: t.Integer(),
  updatedAt: t.Number(),
});
const errorSchema = t.Object({ error: t.String() });
const viewerStateSchema = t.Object({
  universes: t.Array(t.Integer({ minimum: 1, maximum: 63_999 })),
});
const engineTelemetrySchema = t.Object({
  closed: t.Boolean(),
  running: t.Boolean(),
  outputCount: t.Integer({ minimum: 0 }),
  outputs: t.Array(outputSnapshotSchema),
  loopIterations: t.Integer({ minimum: 0 }),
  lastLoopStartedAt: t.Union([t.Number(), t.Null()]),
  lastLoopCompletedAt: t.Union([t.Number(), t.Null()]),
  lastLoopDurationMs: t.Union([t.Number(), t.Null()]),
  transport: t.Object({
    sendAttempts: t.Integer({ minimum: 0 }),
    sendFailures: t.Integer({ minimum: 0 }),
    sendRetries: t.Integer({ minimum: 0 }),
    sendSuccesses: t.Integer({ minimum: 0 }),
    sendTimeouts: t.Integer({ minimum: 0 }),
  }),
});
const viewerTelemetrySchema = t.Object({
  droppedUpdates: t.Integer({ minimum: 0 }),
  packetsReceived: t.Integer({ minimum: 0 }),
  selectedUniverses: t.Array(t.Integer()),
  streamCount: t.Integer({ minimum: 0 }),
});
const viewerUniverseParamsSchema = t.Object({
  universe: t.String({ pattern: "^-?\\d+$" }),
});
const errorResponseDocument = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
});
const outputResponseDocument = {
  200: {
    description: "Output snapshot",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/OutputSnapshot" },
      },
    },
  },
  400: errorResponseDocument("Invalid request"),
  409: errorResponseDocument("Lifecycle conflict"),
  503: errorResponseDocument("Transport or persistence unavailable"),
};
const outputLookupResponseDocument = {
  ...outputResponseDocument,
  404: errorResponseDocument("Output not found"),
};
const clearResponseDocument = {
  200: {
    description: "Output cleared",
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean", const: true } },
        },
      },
    },
  },
  400: errorResponseDocument("Invalid request"),
  404: errorResponseDocument("Output not found"),
  409: errorResponseDocument("Lifecycle conflict"),
  503: errorResponseDocument("Transport or persistence unavailable"),
};
const componentResponse = (schema: string, description: string) => ({
  200: {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${schema}` },
      },
    },
  },
  400: errorResponseDocument("Invalid request"),
  409: errorResponseDocument("Lifecycle conflict"),
  503: errorResponseDocument("Dependency unavailable"),
});

const integerParam = (value: string, label: string): number => {
  if (!/^-?\d+$/.test(value)) {
    throw new SacnValidationError(
      `${label} must be an integer.`,
      label === "Universe" ? "INVALID_UNIVERSE" : "INVALID_PRIORITY",
    );
  }
  return Number(value);
};

const addressOf = (params: OutputParams) => ({
  universe: integerParam(params.universe, "Universe"),
  priority: integerParam(params.priority, "Priority"),
});

const bodyObject = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SacnValidationError(
      "Request body must be an object.",
      "INVALID_FRAME",
    );
  }
  return body as Record<string, unknown>;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "Internal server error.";

const statusOf = (error: unknown): number => {
  if (error instanceof SacnValidationError) return 400;
  if (error instanceof SacnLifecycleError) return 409;
  if (
    error instanceof DependencyUnavailableError ||
    error instanceof PersistenceError ||
    error instanceof TransportError
  ) {
    return 503;
  }
  return 500;
};

const fail = (set: RouteSet, error: unknown): { error: string } => {
  set.status = statusOf(error);
  return { error: messageOf(error) };
};

const deprecated = (
  set: RouteSet,
  successor: string,
  sunset: string,
): void => {
  set.headers.deprecation = "true";
  set.headers.link = `<${successor}>; rel="successor-version"`;
  set.headers.sunset = sunset;
};

const channelsFrom = (
  body: unknown,
): {
  mode: "set" | "fade" | "transition";
  values?: ChannelValues;
  writes?: readonly TransitionWrite[];
  durationMs?: number;
  idleFps?: number;
  sourceName?: string;
  cid?: string;
} => {
  const record = bodyObject(body);
  const sharedDuration =
    typeof record.durationMs === "number" ? record.durationMs : undefined;
  const value = record.channels ?? record.changes;
  const options = {
    ...(sharedDuration === undefined ? {} : { durationMs: sharedDuration }),
    ...(record.idleFps === undefined
      ? {}
      : { idleFps: record.idleFps as number }),
    ...(record.sourceName === undefined
      ? {}
      : { sourceName: record.sourceName as string }),
    ...(record.cid === undefined ? {} : { cid: record.cid as string }),
  };

  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const values: Record<number, number> = {};
    for (const [key, channelValue] of Object.entries(value)) {
      values[Number(key)] = channelValue as number;
    }
    if (sharedDuration !== undefined && sharedDuration > 0) {
      return { mode: "fade", values, ...options };
    }
    return { mode: "set", values, ...options };
  }

  if (!Array.isArray(value)) {
    throw new SacnValidationError(
      "Body must contain a channels array or map.",
      "INVALID_CHANNEL",
    );
  }

  const writes: ChannelWrite[] = value.map((item) => {
    const change = bodyObject(item);
    const durationMs =
      typeof change.durationMs === "number" ? change.durationMs : undefined;
    return {
      channel: change.channel as number,
      value: change.value as number,
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  });

  const hasPerChannelDuration = writes.some(
    (write) => write.durationMs !== undefined && write.durationMs > 0,
  );
  if (hasPerChannelDuration) {
    return {
      mode: "transition",
      writes: writes.map((write) => ({
        channel: write.channel,
        value: write.value,
        durationMs: write.durationMs ?? sharedDuration ?? 0,
      })),
      ...options,
    };
  }
  const values: Record<number, number> = {};
  for (const write of writes) values[write.channel] = write.value;
  if (sharedDuration !== undefined && sharedDuration > 0) {
    return { mode: "fade", values, ...options };
  }
  return { mode: "set", values, ...options };
};

const frameFrom = (
  body: unknown,
): {
  values: readonly number[] | Uint8Array;
  durationMs?: number;
  idleFps?: number;
  sourceName?: string;
  cid?: string;
} => {
  const record = bodyObject(body);
  const values = record.values ?? record.initialValues;
  if (!Array.isArray(values) && !(values instanceof Uint8Array)) {
    throw new SacnValidationError(
      "Body must contain a values array.",
      "INVALID_FRAME",
    );
  }
  const durationMs = record.durationMs;
  return {
    values,
    ...(durationMs === undefined ? {} : { durationMs: durationMs as number }),
    ...(record.idleFps === undefined
      ? {}
      : { idleFps: record.idleFps as number }),
    ...(record.sourceName === undefined
      ? {}
      : { sourceName: record.sourceName as string }),
    ...(record.cid === undefined ? {} : { cid: record.cid as string }),
  };
};

const universeOf = (
  source: SacnSourceContract,
  params: OutputParams,
  extras: {
    cid?: string;
    idleFps?: number;
    sourceName?: string;
  } = {},
): UniverseContract => {
  const address = addressOf(params);
  return source.universe(address.universe, {
    priority: address.priority,
    ...extras,
  });
};

const applyChannels = async (
  universe: UniverseContract,
  parsed: ReturnType<typeof channelsFrom>,
) => {
  if (parsed.mode === "fade" && parsed.values) {
    return universe.fadeChannels(parsed.values, {
      durationMs: parsed.durationMs ?? 0,
    });
  }
  if (parsed.mode === "transition" && parsed.writes) {
    return universe.transition(parsed.writes);
  }
  if (parsed.values) {
    return universe.setChannels(parsed.values);
  }
  throw new SacnValidationError(
    "Body must contain channel values.",
    "INVALID_CHANNEL",
  );
};

/**
 * Creates an unbound Elysia route plugin. CORS and server binding deliberately
 * remain the host application's responsibility.
 */
export const createSacnHttpAdapter = (options: SacnHttpAdapterOptions) => {
  const prefix = options.prefix ?? "/sacn";
  const sunset = options.sunset ?? "Wed, 01 Jul 2027 00:00:00 GMT";
  const maxWebSocketClients = options.maxWebSocketClients ?? 64;
  const webSocketQueueCapacity = options.webSocketQueueCapacity ?? 32;
  if (!Number.isInteger(maxWebSocketClients) || maxWebSocketClients < 1) {
    throw new SacnValidationError(
      "Maximum WebSocket clients must be a positive integer.",
      "INVALID_FRAME",
    );
  }
  if (!Number.isInteger(webSocketQueueCapacity) || webSocketQueueCapacity < 1) {
    throw new SacnValidationError(
      "WebSocket queue capacity must be a positive integer.",
      "INVALID_FRAME",
    );
  }
  interface ViewerClient {
    readonly socket: {
      send(payload: unknown): unknown;
      close(): unknown;
    };
    readonly pending: Map<number, ViewerPacket>;
    scheduled: boolean;
  }
  const clients = new Set<ViewerClient>();
  const closeClient = (client: ViewerClient): void => {
    clients.delete(client);
    client.pending.clear();
    try {
      client.socket.close();
    } catch {
      // The client is already discarded.
    }
  };
  const flushClient = (client: ViewerClient): void => {
    client.scheduled = false;
    const packets = [...client.pending.values()];
    client.pending.clear();
    for (const packet of packets) {
      try {
        const status = client.socket.send({ packet, type: "viewer-packet" });
        if (typeof status === "number" && status <= 0) {
          closeClient(client);
          return;
        }
      } catch {
        closeClient(client);
        return;
      }
    }
  };
  const dispatchViewerPacket = (packet: ViewerPacket): void => {
    try {
      options.onViewerPacket?.(packet);
    } catch {
      // Host packet hooks are isolated from WebSocket fanout.
    }
    for (const client of clients) {
      if (client.pending.has(packet.universe)) {
        client.pending.delete(packet.universe);
      } else if (client.pending.size >= webSocketQueueCapacity) {
        const oldestUniverse = client.pending.keys().next().value;
        if (oldestUniverse !== undefined) client.pending.delete(oldestUniverse);
      }
      client.pending.set(packet.universe, packet);
      if (!client.scheduled) {
        client.scheduled = true;
        queueMicrotask(() => flushClient(client));
      }
    }
  };
  const unsubscribePackets =
    options.viewer
      ? options.viewer.subscribe(dispatchViewerPacket)
      : undefined;

  const app = new Elysia({ adapter: node(), prefix })
    .use(
      openapi({
        path: options.openapiPath ?? "/openapi",
        documentation: {
          components: {
            schemas: {
              Error: errorSchema as never,
              EngineTelemetry: engineTelemetrySchema as never,
              OutputSnapshot: outputSnapshotSchema as never,
              ViewerState: viewerStateSchema as never,
              ViewerTelemetry: viewerTelemetrySchema as never,
            },
          },
          info: {
            title: "@helioslx/core sACN API",
            version: "0.1.0",
          },
        },
      }),
    )
    .onBeforeHandle(async ({ request, set }) => {
      try {
        const result = await options.auth?.({ request });
        if (result instanceof Response) return result;
        if (result === false) {
          set.status = 401;
          return { error: "Unauthorized." };
        }
      } catch (error) {
        return fail(set, error);
      }
    })
    .onError(({ code, error, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { error: error.message };
      }
    })
    .onStop(() => {
      unsubscribePackets?.();
      clients.clear();
    })
    .get("/health/live", () => ({ status: "ok" as const }), {
      response: { 200: t.Object({ status: t.Literal("ok") }) },
    })
    .get(
      "/health/ready",
      ({ set }) => {
        const telemetry = options.source.getTelemetry();
        if (!telemetry.running || telemetry.closed) {
          set.status = 503;
          return { status: "not-ready" as const };
        }
        return { status: "ready" as const };
      },
      {
        response: {
          200: t.Object({ status: t.Literal("ready") }),
          503: t.Object({ status: t.Literal("not-ready") }),
        },
      },
    )
    .get("/universes", async ({ set }) => {
      try {
        return await options.source.listUniverses();
      } catch (error) {
        return fail(set, error);
      }
    }, {
      detail: {
        responses: {
          200: {
            description: "Active outputs",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/OutputSnapshot" },
                },
              },
            },
          },
          409: errorResponseDocument("Lifecycle conflict"),
          503: errorResponseDocument("Persistence unavailable"),
        } as never,
      },
    })
    .get("/engine/telemetry", () => options.source.getTelemetry(), {
      detail: {
        responses: componentResponse(
          "EngineTelemetry",
          "Engine telemetry",
        ) as never,
      },
    })
    .get(
      "/universes/:universe/priorities/:priority",
      async ({ params, set }) => {
        try {
          const output = await universeOf(options.source, params).get();
          if (!output) {
            set.status = 404;
            return { error: "Output not found." };
          }
          return output;
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        detail: { responses: outputLookupResponseDocument as never },
        params: outputParamsSchema,
      },
    )
    .put(
      "/universes/:universe/priorities/:priority",
      async ({ body, params, set }) => {
        try {
          const record = bodyObject(body);
          const frame = frameFrom({
            ...record,
            values:
              record.initialValues ??
              record.values ??
              Array.from({ length: SLOT_COUNT }, () => 0),
          });
          const universe = universeOf(options.source, params, {
            ...(frame.cid === undefined ? {} : { cid: frame.cid }),
            ...(frame.idleFps === undefined ? {} : { idleFps: frame.idleFps }),
            ...(frame.sourceName === undefined
              ? {}
              : { sourceName: frame.sourceName }),
          });
          const existing = await universe.get();
          const supplied = record.initialValues ?? record.values;
          const values =
            Array.isArray(supplied) || supplied instanceof Uint8Array
              ? supplied
              : existing?.target ?? Array.from({ length: SLOT_COUNT }, () => 0);
          return await universe.write(values, {
            ...(frame.durationMs === undefined
              ? {}
              : { durationMs: frame.durationMs }),
          });
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        body: upsertBodySchema,
        detail: { responses: outputResponseDocument as never },
        params: outputParamsSchema,
      },
    )
    .post(
      "/universes/:universe/priorities/:priority/channels",
      async ({ body, params, set }) => {
        try {
          const parsed = channelsFrom(body);
          const universe = universeOf(options.source, params, {
            ...(parsed.cid === undefined ? {} : { cid: parsed.cid }),
            ...(parsed.idleFps === undefined ? {} : { idleFps: parsed.idleFps }),
            ...(parsed.sourceName === undefined
              ? {}
              : { sourceName: parsed.sourceName }),
          });
          return await applyChannels(universe, parsed);
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        body: channelsBodySchema,
        detail: { responses: outputResponseDocument as never },
        params: outputParamsSchema,
      },
    )
    .post(
      "/universes/:universe/priorities/:priority/frame",
      async ({ body, params, set }) => {
        try {
          const frame = frameFrom(body);
          const universe = universeOf(options.source, params, {
            ...(frame.cid === undefined ? {} : { cid: frame.cid }),
            ...(frame.idleFps === undefined ? {} : { idleFps: frame.idleFps }),
            ...(frame.sourceName === undefined
              ? {}
              : { sourceName: frame.sourceName }),
          });
          return await universe.write(frame.values, {
            ...(frame.durationMs === undefined
              ? {}
              : { durationMs: frame.durationMs }),
          });
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        body: frameBodySchema,
        detail: { responses: outputResponseDocument as never },
        params: outputParamsSchema,
      },
    )
    .delete(
      "/universes/:universe/priorities/:priority",
      async ({ params, set }) => {
        try {
          const removed = await universeOf(options.source, params).clear();
          if (!removed) {
            set.status = 404;
            return { error: "Output not found." };
          }
          return { ok: true as const };
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        detail: {
          responses: {
            200: {
              description: "Output cleared",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok"],
                    properties: { ok: { type: "boolean", const: true } },
                  },
                },
              },
            },
            400: errorResponseDocument("Invalid request"),
            404: errorResponseDocument("Output not found"),
            409: errorResponseDocument("Lifecycle conflict"),
            503: errorResponseDocument("Transport or persistence unavailable"),
          } as never,
        },
        params: outputParamsSchema,
      },
    );

  if (options.viewer) {
    app
      .get("/viewer/universes", () => ({
        universes: options.viewer?.getSelectedUniverses() ?? [],
      }), {
        detail: {
          responses: componentResponse(
            "ViewerState",
            "Selected viewer universes",
          ) as never,
        },
      })
      .get("/viewer/telemetry", () => options.viewer?.getTelemetry(), {
        detail: {
          responses: componentResponse(
            "ViewerTelemetry",
            "Viewer telemetry",
          ) as never,
        },
      })
      .put(
        "/viewer/universes",
        async ({ body, set }) => {
          try {
            const record = bodyObject(body);
            if (!Array.isArray(record.universes)) {
              throw new SacnValidationError(
                "Body must contain a universes array.",
                "INVALID_UNIVERSE",
              );
            }
            return {
              universes: await options.viewer?.setSelectedUniverses(
                record.universes as number[],
              ),
            };
          } catch (error) {
            return fail(set, error);
          }
        },
        {
          body: viewerStateSchema,
          detail: {
            responses: componentResponse(
              "ViewerState",
              "Updated viewer universes",
            ) as never,
          },
        },
      )
      .post(
        "/viewer/universes/:universe",
        async ({ params, set }) => {
          try {
            return {
              universes: await options.viewer?.addUniverse(
                integerParam(params.universe, "Universe"),
              ),
            };
          } catch (error) {
            return fail(set, error);
          }
        },
        {
          detail: {
            responses: componentResponse(
              "ViewerState",
              "Updated viewer universes",
            ) as never,
          },
          params: viewerUniverseParamsSchema,
        },
      )
      .delete(
        "/viewer/universes/:universe",
        async ({ params, set }) => {
          try {
            return {
              universes: await options.viewer?.removeUniverse(
                integerParam(params.universe, "Universe"),
              ),
            };
          } catch (error) {
            return fail(set, error);
          }
        },
        {
          detail: {
            responses: componentResponse(
              "ViewerState",
              "Updated viewer universes",
            ) as never,
          },
          params: viewerUniverseParamsSchema,
        },
      )
      .delete(
        "/viewer/universes",
        async ({ set }) => {
          try {
            return {
              universes: await options.viewer?.setSelectedUniverses([]),
            };
          } catch (error) {
            return fail(set, error);
          }
        },
        {
          detail: {
            responses: componentResponse(
              "ViewerState",
              "Cleared viewer universes",
            ) as never,
          },
        },
      )
      .ws("/viewer/ws", {
        open(ws) {
          if (clients.size >= maxWebSocketClients) {
            ws.close();
            return;
          }
          const client: ViewerClient = {
            socket: ws,
            pending: new Map(),
            scheduled: false,
          };
          clients.add(client);
          ws.send({
            type: "viewer-state",
            viewer: {
              universes: options.viewer?.getSelectedUniverses() ?? [],
            },
          });
        },
        close(ws) {
          for (const client of clients) {
            if (client.socket === ws) {
              clients.delete(client);
              client.pending.clear();
              break;
            }
          }
        },
        message() {
          // Viewer sockets are intentionally server-to-client only.
        },
      });
  }

  const mark = (set: RouteSet, successor: string): void =>
    deprecated(set, `${prefix}${successor}`, sunset);

  return app
    .get("/outputs", async ({ set }) => {
      mark(set, "/universes");
      try {
        return await options.source.listUniverses();
      } catch (error) {
        return fail(set, error);
      }
    }, {
      detail: {
        deprecated: true,
        responses: {
          200: {
            description: "Active outputs",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/OutputSnapshot" },
                },
              },
            },
          },
        } as never,
      },
    })
    .get("/telemetry", ({ set }) => {
      mark(set, "/engine/telemetry");
      return options.source.getTelemetry();
    }, {
      detail: {
        deprecated: true,
        responses: componentResponse(
          "EngineTelemetry",
          "Engine telemetry",
        ) as never,
      },
    })
    .get(
      "/outputs/:universe/:priority",
      async ({ params, set }) => {
        mark(
          set,
          `/universes/${params.universe}/priorities/${params.priority}`,
        );
        try {
          const output = await universeOf(options.source, params).get();
          if (!output) {
            set.status = 404;
            return { error: "Output not found." };
          }
          return output;
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        detail: {
          deprecated: true,
          responses: outputLookupResponseDocument as never,
        },
        params: outputParamsSchema,
      },
    )
    .put(
      "/outputs/:universe/:priority",
      async ({ body, params, set }) => {
        mark(
          set,
          `/universes/${params.universe}/priorities/${params.priority}`,
        );
        try {
          const record = bodyObject(body);
          const frame = frameFrom({
            ...record,
            values:
              record.initialValues ??
              record.values ??
              Array.from({ length: SLOT_COUNT }, () => 0),
          });
          const universe = universeOf(options.source, params, {
            ...(frame.cid === undefined ? {} : { cid: frame.cid }),
            ...(frame.idleFps === undefined ? {} : { idleFps: frame.idleFps }),
            ...(frame.sourceName === undefined
              ? {}
              : { sourceName: frame.sourceName }),
          });
          const existing = await universe.get();
          const supplied = record.initialValues ?? record.values;
          const values =
            Array.isArray(supplied) || supplied instanceof Uint8Array
              ? supplied
              : existing?.target ?? Array.from({ length: SLOT_COUNT }, () => 0);
          return await universe.write(values, {
            ...(frame.durationMs === undefined
              ? {}
              : { durationMs: frame.durationMs }),
          });
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        body: upsertBodySchema,
        detail: {
          deprecated: true,
          responses: outputResponseDocument as never,
        },
        params: outputParamsSchema,
      },
    )
    .post(
      "/outputs/:universe/:priority/channels",
      async ({ body, params, set }) => {
        mark(
          set,
          `/universes/${params.universe}/priorities/${params.priority}/channels`,
        );
        try {
          const parsed = channelsFrom(body);
          const universe = universeOf(options.source, params, {
            ...(parsed.cid === undefined ? {} : { cid: parsed.cid }),
            ...(parsed.idleFps === undefined ? {} : { idleFps: parsed.idleFps }),
            ...(parsed.sourceName === undefined
              ? {}
              : { sourceName: parsed.sourceName }),
          });
          return await applyChannels(universe, parsed);
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        body: channelsBodySchema,
        detail: {
          deprecated: true,
          responses: outputResponseDocument as never,
        },
        params: outputParamsSchema,
      },
    )
    .post(
      "/outputs/:universe/:priority/frame",
      async ({ body, params, set }) => {
        mark(
          set,
          `/universes/${params.universe}/priorities/${params.priority}/frame`,
        );
        try {
          const frame = frameFrom(body);
          const universe = universeOf(options.source, params, {
            ...(frame.cid === undefined ? {} : { cid: frame.cid }),
            ...(frame.idleFps === undefined ? {} : { idleFps: frame.idleFps }),
            ...(frame.sourceName === undefined
              ? {}
              : { sourceName: frame.sourceName }),
          });
          return await universe.write(frame.values, {
            ...(frame.durationMs === undefined
              ? {}
              : { durationMs: frame.durationMs }),
          });
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        body: frameBodySchema,
        detail: {
          deprecated: true,
          responses: outputResponseDocument as never,
        },
        params: outputParamsSchema,
      },
    )
    .delete(
      "/outputs/:universe/:priority",
      async ({ params, set }) => {
        mark(
          set,
          `/universes/${params.universe}/priorities/${params.priority}`,
        );
        try {
          const removed = await universeOf(options.source, params).clear();
          if (!removed) {
            set.status = 404;
            return { error: "Output not found." };
          }
          return { ok: true as const };
        } catch (error) {
          return fail(set, error);
        }
      },
      {
        detail: {
          deprecated: true,
          responses: clearResponseDocument as never,
        },
        params: outputParamsSchema,
      },
    );
};

/** Connects viewer packets to a host-owned WebSocket or SSE implementation. */
export const subscribeViewerPackets = (
  viewer: ViewerServiceContract,
  listener: (packet: ViewerPacket) => void,
): (() => void) => viewer.subscribe(listener);
