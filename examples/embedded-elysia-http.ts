import { createSacnSource } from "@helioslx/core";
import { createSacnHttpAdapter } from "@helioslx/core/http";
import { RecordingTransport } from "@helioslx/core/testing";
import { Elysia } from "elysia";

const source = createSacnSource({
	transport: new RecordingTransport(),
	ownsTransport: true,
});

await source.start();

const sacn = createSacnHttpAdapter({
	source,
	prefix: "/sacn",
});

const app = new Elysia().use(sacn).get("/", () => ({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port);
console.info(`Listening on http://127.0.0.1:${port}`);

const shutdown = async (): Promise<void> => {
	await app.stop();
	await source.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
