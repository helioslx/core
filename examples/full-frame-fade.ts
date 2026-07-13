import { createSacnSource, SLOT_COUNT } from "@helioslx/core";
import { RecordingTransport } from "@helioslx/core/testing";

const source = createSacnSource({
	transport: new RecordingTransport(),
	ownsTransport: true,
});

try {
	const frame = new Uint8Array(SLOT_COUNT);
	frame[0] = 255;
	frame[1] = 128;
	frame[2] = 64;

	const snapshot = await source.universe(1).write(frame, {
		durationMs: 2_000,
	});

	console.info(
		`Scheduled fade for universe ${snapshot.universe} with ${snapshot.activeTransitions} active transitions.`,
	);
	// write schedules the fade; it does not wait for the duration to elapse.
} finally {
	await source.close();
}
