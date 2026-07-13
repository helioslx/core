import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/node.ts",
		"src/redis.ts",
		"src/http.ts",
		"src/testing.ts",
	],
	format: ["esm"],
	dts: true,
	clean: true,
	sourcemap: true,
	platform: "neutral",
	deps: {
		neverBundle: [
			/^node:/,
			"sacn",
			"redis",
			"elysia",
			"@elysiajs/node",
			"@elysiajs/openapi",
		],
	},
});
