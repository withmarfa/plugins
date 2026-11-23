import type { FileSource } from "@withmarfa/connector";

/**
 * Finishes a vendor read outside the scoped write and replays what it read,
 * as a stream, for each attempt the kit makes. The bytes are held in memory,
 * never written to a file, which the permission flags do not allow a
 * connector; their size is what `download` already limits.
 */
export async function stageContent(
  content: Awaited<ReturnType<FileSource["load"]>>,
  signal: AbortSignal,
): Promise<FileSource["load"]> {
  const chunks: Uint8Array[] = [];
  if (content.bytes instanceof Uint8Array) {
    chunks.push(content.bytes);
  } else {
    const reader = content.bytes.getReader();
    // A read that never answers ends when the run is stopped.
    const stop = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const read = await reader.read();
        if (read.done) break;
        chunks.push(read.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  signal.throwIfAborted();
  return (loadSignal) => {
    loadSignal.throwIfAborted();
    let next = 0;
    return Promise.resolve({
      bytes: new ReadableStream<Uint8Array>({
        pull(stream) {
          const chunk = chunks[next++];
          if (chunk === undefined) stream.close();
          else stream.enqueue(chunk.slice());
        },
      }),
      mime_type: content.mime_type,
    });
  };
}
