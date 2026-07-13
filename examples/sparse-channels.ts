import { createSacnSource } from "@helioslx/core";
import { RecordingTransport } from "@helioslx/core/testing";

const source = createSacnSource({
	transport: new RecordingTransport(),
	ownsTransport: true,
});

const universe = source.universe(1);

try {
	await universe.transition([
		{ channel: 1, value: 255, durationMs: 1_000 },
		{ channel: 10, value: 64, durationMs: 2_000 },
		{ channel: 512, value: 128, durationMs: 3_000 },
	]);

	await universe.fadeChannels({ 1: 0 }, { durationMs: 250 });

	console.info(await universe.get());
} finally {
	await source.close();
}
