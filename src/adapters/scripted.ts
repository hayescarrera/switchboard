// A stand-in agent whose replies are worked out from what it receives, one
// short run per message. Used by tests and demos in place of a real vendor.

import { randomUUID } from "node:crypto";
import type { AgentCard, Thread } from "../types.js";
import type { Adapter, AdapterEvent, Delivery, RunRef } from "./adapter.js";

export class ScriptedAdapter implements Adapter {
  private runs = new Map<string, AdapterEvent[]>();
  readonly received: Delivery[] = [];

  constructor(private readonly respond: (d: Delivery) => AdapterEvent[]) {}

  describe(): AgentCard {
    return { name: "Scripted" };
  }

  async send(_thread: Thread, delivery: Delivery): Promise<RunRef> {
    const externalRef = `scripted-${randomUUID()}`;
    this.received.push(delivery);
    this.runs.set(externalRef, this.respond(delivery));
    return { externalRef };
  }

  async followUp(): Promise<void> {}

  async *events(ref: RunRef): AsyncIterable<AdapterEvent> {
    yield* this.runs.get(ref.externalRef) ?? [];
  }

  async cancel(ref: RunRef): Promise<void> {
    this.runs.delete(ref.externalRef);
  }
}
