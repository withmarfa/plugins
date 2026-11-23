import { expect, it } from "vitest";
import { stageContent } from "../src/content-staging.js";
import { download, StorageLimitExceeded } from "../src/content.js";

const signal = new AbortController().signal;
const stream = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

it("replays a staged download for every attempt, after an earlier reader stops", async () => {
  const bytes = new Uint8Array(200_000).fill(42);
  const load = await stageContent(
    { bytes: stream(bytes), mime_type: "application/pdf" },
    signal,
  );
  const first = await load(signal);
  expect(first.bytes).toBeInstanceOf(ReadableStream);
  if (!(first.bytes instanceof ReadableStream))
    throw new Error("staged load did not stream");
  const reader = first.bytes.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  const replay = await load(signal);
  expect(replay.mime_type).toBe("application/pdf");
  expect(
    new Uint8Array(await new Response(replay.bytes).arrayBuffer()),
  ).toEqual(bytes);
  const again = await load(signal);
  expect(new Uint8Array(await new Response(again.bytes).arrayBuffer())).toEqual(
    bytes,
  );
});

it("keeps every chunk of a download in order, and holds bytes it was given whole", async () => {
  const load = await stageContent(
    {
      bytes: stream(
        new Uint8Array([1, 2]),
        new Uint8Array([3]),
        new Uint8Array([4, 5]),
      ),
      mime_type: "application/pdf",
    },
    signal,
  );
  expect(
    new Uint8Array(
      await new Response((await load(signal)).bytes).arrayBuffer(),
    ),
  ).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  const whole = await stageContent(
    { bytes: new Uint8Array([9, 8]), mime_type: "text/plain" },
    signal,
  );
  expect(
    new Uint8Array(
      await new Response((await whole(signal)).bytes).arrayBuffer(),
    ),
  ).toEqual(new Uint8Array([9, 8]));
});

it("refuses a streamed resource that exceeds its bound, and keeps nothing of it", async () => {
  const content = await download(
    "https://readwise-assets.s3.amazonaws.com/fixture.pdf",
    signal,
    {
      maxBytes: 512,
      fetch: () =>
        Promise.resolve(
          new Response(stream(new Uint8Array(256), new Uint8Array(257))),
        ),
    },
  );
  await expect(stageContent(content, signal)).rejects.toBeInstanceOf(
    StorageLimitExceeded,
  );
});

it("stops reading on cancellation and cancels the vendor stream", async () => {
  const controller = new AbortController();
  let started: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let pulls = 0;
  let cancelled = false;
  const content = {
    bytes: new ReadableStream<Uint8Array>({
      pull(stream) {
        if (pulls++ === 0) {
          stream.enqueue(new Uint8Array(256));
          return;
        }
        started();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    }),
    mime_type: "application/pdf",
  };
  const staging = stageContent(content, controller.signal);
  const rejected = expect(staging).rejects.toMatchObject({
    name: "AbortError",
  });
  await reading;
  controller.abort();
  await rejected;
  expect(cancelled).toBe(true);
});
