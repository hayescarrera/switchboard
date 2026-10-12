// The adapter interface from CLAUDE.md section 6.3. Every agent type implements
// it, so the router never needs to know who it is talking to.

import type { AgentCard, MessageType, Thread, ThreadContext } from "../types.js";

/** What an adapter receives: one message, with only the context its line allows. */
export interface Delivery {
  messageId: string;
  type: MessageType;
  body: string;
  context: ThreadContext;
  fromAgentId: string;
  toAgentId: string;
}

/** The adapter's handle on the work it started (e.g. a Cursor agent id). */
export interface RunRef {
  externalRef: string;
}

export type AdapterEvent =
  | { kind: "progress"; body: string }
  | { kind: "question"; body: string }
  | { kind: "answer"; body: string }
  | { kind: "result"; body: string }
  | { kind: "error"; body: string }
  /** The agent can't go on without the user. `body` is the question for them; `summary` says why. */
  | { kind: "escalate"; body: string; summary: string };

export interface Adapter {
  describe(): AgentCard;
  /** Start work on, or deliver, a message. */
  send(thread: Thread, delivery: Delivery): Promise<RunRef>;
  /** Pass a message into a run that is already going (an answer, or a nudge). */
  followUp(ref: RunRef, body: string): Promise<void>;
  /** Everything the run reports. The stream ends when the run is finished. */
  events(ref: RunRef): AsyncIterable<AdapterEvent>;
  cancel(ref: RunRef): Promise<void>;
}
