// A fake agent for testing the hub. It needs no vendor account.
//
// Modes:
//   echo     - a task gets a progress update then a result; a question gets an
//              answer; answers, statuses and results are just acknowledged.
//   ask_back - answers everything with another question (two of these talking
//              to each other is the endless loop the loop guard exists for).
//   silent   - accepts the message, then says nothing until cancelled
//              (a stalled run, for timeout tests).

import { randomUUID } from "node:crypto";
import type { AgentCard, Thread } from "../types.js";
import type { Adapter, AdapterEvent, Delivery, RunRef } from "./adapter.js";

export type EchoMode = "echo" | "ask_back" | "silent";

interface EchoRun {
  queue: AdapterEvent[];
  ended: boolean;
  wake?: () => void;
  followUps: string[];
}

export class EchoAdapter implements Adapter {
  private runs = new Map<string, EchoRun>();

  constructor(private readonly mode: EchoMode = "echo") {}

  describe(): AgentCard {
    return {
      name: `Echo (${this.mode})`,
      description: "Test agent that repeats what it receives.",
      skills: [{ id: "echo", name: "Echo" }],
    };
  }

  async send(_thread: Thread, delivery: Delivery): Promise<RunRef> {
    const externalRef = `echo-${randomUUID()}`;
    const run: EchoRun = { queue: [], ended: false, followUps: [] };
    this.runs.set(externalRef, run);

    if (this.mode === "ask_back") {
      this.push(run, { kind: "question", body: `why ${delivery.body}?` });
      this.end(run);
    } else if (this.mode === "echo") {
      if (delivery.type === "task") {
        this.push(run, { kind: "progress", body: "working on it" });
        this.push(run, { kind: "result", body: `echo: ${delivery.body}` });
      } else if (delivery.type === "question") {
        this.push(run, { kind: "answer", body: `echo: ${delivery.body}` });
      }
      this.end(run);
    }
    // silent: leave the run open with nothing to say.
    return { externalRef };
  }

  async followUp(ref: RunRef, body: string): Promise<void> {
    this.runs.get(ref.externalRef)?.followUps.push(body);
  }

  /** Messages passed into a run with followUp (lets tests see nudges). */
  followUpsFor(externalRef: string): string[] {
    return this.runs.get(externalRef)?.followUps ?? [];
  }

  async *events(ref: RunRef): AsyncIterable<AdapterEvent> {
    const run = this.runs.get(ref.externalRef);
    if (!run) return;
    while (true) {
      const next = run.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (run.ended) return;
      await new Promise<void>((resolve) => (run.wake = resolve));
    }
  }

  async cancel(ref: RunRef): Promise<void> {
    const run = this.runs.get(ref.externalRef);
    if (run) this.end(run);
  }

  private push(run: EchoRun, event: AdapterEvent) {
    run.queue.push(event);
    run.wake?.();
  }

  private end(run: EchoRun) {
    run.ended = true;
    run.wake?.();
  }
}
