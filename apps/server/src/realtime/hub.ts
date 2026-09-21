import type { ServerEvent } from '@sindral/shared';

export type Subscriber = (event: ServerEvent) => void;

/** In-memory per-user fan-out for server-sent events. One process only; scale-out would need a shared bus. */
export class Hub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  subscribe(userId: string, subscriber: Subscriber): () => void {
    let set = this.subscribers.get(userId);
    if (!set) {
      set = new Set();
      this.subscribers.set(userId, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.subscribers.get(userId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(userId);
    };
  }

  publish(userId: string, event: ServerEvent): void {
    const set = this.subscribers.get(userId);
    if (!set) return;
    for (const subscriber of set) {
      try {
        subscriber(event);
      } catch {
        // A broken subscriber must not prevent delivery to the others.
      }
    }
  }

  subscriberCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0;
  }
}
