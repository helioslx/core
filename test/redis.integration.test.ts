import { describe, expect, it } from "vitest";
import { SLOT_COUNT } from "../src/index.js";
import { RedisOutputStore, RedisViewerStore } from "../src/redis.js";

const redisUrl = process.env.REDIS_URL;
const integrationTest = redisUrl ? it : it.skip;

describe("Redis integration", () => {
	integrationTest(
		"round-trips validated output and viewer records",
		async () => {
			if (!redisUrl) return;
			const namespace = `helioslx-test-${process.pid}-${Date.now()}`;
			const outputs = new RedisOutputStore({
				namespace,
				url: redisUrl,
			});
			const viewers = new RedisViewerStore({
				namespace,
				url: redisUrl,
			});
			try {
				const record = {
					cid: "00000000-0000-4000-8000-000000000001",
					idleFps: 2,
					priority: 100,
					sourceName: "redis-integration",
					target: Array.from({ length: SLOT_COUNT }, () => 7),
					universe: 1,
					updatedAt: Date.now(),
				} as const;
				await outputs.save(record);
				expect(
					(await outputs.get({ universe: 1, priority: 100 }))?.target[0],
				).toBe(7);
				expect(await outputs.list()).toHaveLength(1);
				await outputs.remove({ universe: 1, priority: 100 });
				expect(await outputs.list()).toHaveLength(0);

				await viewers.save({
					selectedUniverses: [2, 1],
					updatedAt: Date.now(),
				});
				expect((await viewers.load())?.selectedUniverses).toEqual([1, 2]);
			} finally {
				await Promise.allSettled([outputs.close(), viewers.close()]);
			}
		},
	);
});
