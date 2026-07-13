import { ViewerService } from "@helioslx/core";
import { NodeSacnReceiver } from "@helioslx/core/node";

const viewer = new ViewerService({
  receiver: new NodeSacnReceiver(),
  ownsReceiver: true,
  streamCapacity: 16,
});

await viewer.start();
await viewer.setSelectedUniverses([1, 2]);

const unsubscribe = viewer.subscribe((packet) => {
  console.info(
    `Universe ${packet.universe} channel 1=${packet.values[0]} ` +
      `from ${packet.source.sourceName ?? packet.source.cid}`,
  );
});

// Async streams are bounded and coalesce queued packets by universe.
const stream = viewer.packets(8);
const consume = (async (): Promise<void> => {
  for await (const packet of stream) {
    console.info(`Stream received universe ${packet.universe}`);
  }
})();

const close = async (): Promise<void> => {
  unsubscribe();
  stream.close();
  await consume;
  await viewer.close();
};

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

console.info("Watching universes 1 and 2. Press Ctrl-C to stop.");
