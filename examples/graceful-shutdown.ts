import { createSacnSource } from "@helioslx/core";
import { RecordingTransport } from "@helioslx/core/testing";

const source = createSacnSource({
	transport: new RecordingTransport(),
	ownsTransport: true,
	onStop: () => {
		console.info("Scheduler paused.");
	},
	onClose: () => {
		console.info("Source closed.");
	},
});

await source.universe(1).setChannels({ 1: 255 });

// stop() pauses; close() is final teardown (also used by Node process handlers).
await source.stop();
await source.close();
