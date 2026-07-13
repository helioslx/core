import { createSacnSource } from "@helioslx/core";
import { RedisOutputStore } from "@helioslx/core/redis";
import { NodeSacnTransport } from "@helioslx/core/node";

const store = new RedisOutputStore({
	// Uses REDIS_URL when present; otherwise defaults to local Redis.
	...(process.env.REDIS_URL === undefined
		? {}
		: { url: process.env.REDIS_URL }),
});

const source = createSacnSource({
	transport: new NodeSacnTransport({
		sourceName: "Helios Redis example",
		...(process.env.SACN_INTERFACE === undefined
			? {}
			: { iface: process.env.SACN_INTERFACE }),
	}),
	store,
	ownsTransport: true,
	ownsStore: true,
});

try {
	await source.universe(1).fadeChannels({ 1: 255 }, { durationMs: 500 });
} finally {
	// The source closes the store; this store owns its internally-created
	// Redis client by default.
	await source.close();
}
