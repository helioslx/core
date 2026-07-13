import {
	MAX_UNIVERSE,
	MIN_UNIVERSE,
	SLOT_COUNT,
	ViewerService,
	type ViewerPacket,
} from "@helioslx/core";
import { NodeSacnReceiver } from "@helioslx/core/node";

const COLUMNS = 32;
const ROWS = SLOT_COUNT / COLUMNS;
const ESC = "\x1b";
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR_HOME = `${ESC}[2J${ESC}[H`;
const RESET = `${ESC}[0m`;

const clampUniverse = (value: number): number =>
	Math.min(MAX_UNIVERSE, Math.max(MIN_UNIVERSE, value));

const parseUniverse = (raw: string): number => {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < MIN_UNIVERSE || value > MAX_UNIVERSE) {
		throw new Error(
			`Universe must be an integer between ${MIN_UNIVERSE} and ${MAX_UNIVERSE}.`,
		);
	}
	return value;
};

const pad = (value: number, width: number): string =>
	String(value).padStart(width, "0");

const intensityStyle = (value: number): string => {
	if (value <= 0) return `${ESC}[2m`;
	if (value < 64) return `${ESC}[90m`;
	if (value < 128) return `${ESC}[37m`;
	if (value < 192) return `${ESC}[97m`;
	return `${ESC}[1;97m`;
};

const formatAge = (receivedAt: number, now: number): string => {
	const ageMs = Math.max(0, now - receivedAt);
	if (ageMs < 1_000) return `${ageMs}ms`;
	if (ageMs < 60_000) return `${(ageMs / 1_000).toFixed(1)}s`;
	return `${Math.floor(ageMs / 60_000)}m`;
};

const iface = process.env.SACN_INTERFACE;
const startUniverse = parseUniverse(
	process.argv[2] ?? process.env.SACN_UNIVERSE ?? "1",
);

const viewer = new ViewerService({
	receiver: new NodeSacnReceiver({
		...(iface === undefined ? {} : { iface }),
	}),
	ownsReceiver: true,
});

const latest = new Map<number, ViewerPacket>();
let universe = startUniverse;
let closed = false;
let redrawPending = false;
let selecting: Promise<void> = Promise.resolve();
let unsubscribe: () => void = () => undefined;

const render = (): void => {
	if (closed || !process.stdout.isTTY) return;

	const now = Date.now();
	const packet = latest.get(universe);
	const telemetry = viewer.getTelemetry();
	const lines: string[] = [];

	lines.push(`Helios viewer  universe ${universe}`);
	if (packet) {
		const source = packet.source.sourceName ?? packet.source.cid;
		lines.push(
			`source ${source}  pri ${packet.source.priority}  seq ${packet.source.sequence}  age ${formatAge(packet.receivedAt, now)}  packets ${telemetry.packetsReceived}`,
		);
	} else {
		lines.push(`waiting for packets…  packets ${telemetry.packetsReceived}`);
	}
	lines.push("");

	const values = packet?.values;
	for (let row = 0; row < ROWS; row += 1) {
		const startChannel = row * COLUMNS + 1;
		const cells: string[] = [`${pad(startChannel, 3)}`];
		for (let column = 0; column < COLUMNS; column += 1) {
			const index = row * COLUMNS + column;
			const value = values?.[index] ?? 0;
			cells.push(`${intensityStyle(value)}${pad(value, 3)}${RESET}`);
		}
		lines.push(cells.join(" "));
	}

	lines.push("");
	lines.push("←/→ or h/l  universe ±1    [/]  ±10    q  quit");

	process.stdout.write(`${CLEAR_HOME}${HIDE_CURSOR}${lines.join("\n")}\n`);
};

const scheduleRedraw = (): void => {
	if (redrawPending || closed) return;
	redrawPending = true;
	setImmediate(() => {
		redrawPending = false;
		render();
	});
};

const selectUniverse = (next: number): void => {
	const clamped = clampUniverse(next);
	if (clamped === universe) return;
	universe = clamped;
	scheduleRedraw();
	selecting = selecting
		.then(async () => {
			if (closed) return;
			await viewer.setSelectedUniverses([universe]);
		})
		.catch((error: unknown) => {
			if (!closed) {
				process.stderr.write(
					`Failed to select universe ${universe}: ${String(error)}\n`,
				);
			}
		});
};

function restoreTerminal(): void {
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(false);
		process.stdin.pause();
	}
	process.stdin.off("data", onKey);
	process.stdout.write(SHOW_CURSOR);
}

async function close(): Promise<void> {
	if (closed) return;
	closed = true;
	unsubscribe();
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	process.stdout.off("resize", scheduleRedraw);
	restoreTerminal();
	await selecting;
	await viewer.close();
}

function onSignal(): void {
	void close();
}

function onKey(chunk: Buffer): void {
	const key = chunk.toString("utf8");
	if (key === "q" || key === "\u0003") {
		void close();
		return;
	}
	if (key === "\u001b[D" || key === "h") {
		selectUniverse(universe - 1);
		return;
	}
	if (key === "\u001b[C" || key === "l") {
		selectUniverse(universe + 1);
		return;
	}
	if (key === "[") {
		selectUniverse(universe - 10);
		return;
	}
	if (key === "]") {
		selectUniverse(universe + 10);
	}
}
await viewer.start();
await viewer.setSelectedUniverses([universe]);

unsubscribe = viewer.subscribe((packet) => {
	latest.set(packet.universe, packet);
	if (packet.universe === universe) scheduleRedraw();
});

process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
process.stdout.on("resize", scheduleRedraw);

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error("viewer-tui requires an interactive TTY.");
	await close();
	process.exitCode = 1;
} else {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", onKey);
	render();
}
