/**
 * A push queue that a consumer can pull from with `for await`. The bus pushes events as they
 * happen; the surface iterates at its own pace, and `close()` ends the iteration once the drain
 * loop has stopped.
 */

import type { OrcEvent } from "./types.js";

export class EventChannel {
  #buffer: OrcEvent[] = [];
  #waiters: Array<(result: IteratorResult<OrcEvent>) => void> = [];
  #closed = false;

  push(event: OrcEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#buffer.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncGenerator<OrcEvent, void, undefined> {
    for (;;) {
      const buffered = this.#buffer.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<OrcEvent>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

