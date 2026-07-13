import { createSacnSource } from "@helioslx/core/node";

const iface = process.env.SACN_INTERFACE;
const source = createSacnSource({
	name: "Helios quickstart",
	transportOptions: {
		// Use the local IPv4 address on your lighting network.
		...(iface === undefined ? {} : { iface }),
	},
});

const universe = source.universe(1, {
	priority: 100,
	sourceName: "demo",
});

try {
	await universe.fadeChannels(
		{
			1: 255,
			2: 128,
		},
		{ durationMs: 10_000 },
	);

	console.info("Output is running. Press Ctrl-C to stop.");
} catch (error) {
	await source.close();
	throw error;
}
