import type { EventJournal, JournalEvent, NewEvent } from './journal.js';

export type EventListener = (event: JournalEvent) => void;

/**
 * Publishes events: append to the journal (the durable truth), then fan out
 * to live SSE subscribers. Publishing is serialized so journal ids and
 * subscriber notifications keep the same order.
 */
export class EventHub {
  private subscribers = new Set<EventListener>();
  private chain: Promise<unknown> = Promise.resolve();

  public constructor(public readonly journal: EventJournal) {}

  public publish(event: NewEvent): Promise<JournalEvent> {
    const next = this.chain.then(async () => {
      const stored = await this.journal.append(event);
      for (const listener of this.subscribers) {
        try {
          listener(stored);
        } catch {
          // A broken subscriber must not break publishing.
        }
      }
      return stored;
    });
    this.chain = next.catch(() => {});
    return next;
  }

  public subscribe(listener: EventListener): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  public get subscriberCount(): number {
    return this.subscribers.size;
  }
}
