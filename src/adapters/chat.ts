// The user's own chat (Claude app, Claude Code, ...) as a node on the hub.
// It talks to the hub through the MCP connector, and the hub can't type into
// it, so anything sent to it simply stays on the thread. The chat picks it up
// the next time it calls a Switchboard tool (every response carries a digest).

import { randomUUID } from "node:crypto";
import type { AgentCard } from "../types.js";
import type { Adapter, AdapterEvent, RunRef } from "./adapter.js";

export class ChatAdapter implements Adapter {
  describe(): AgentCard {
    return { name: "Your chat", description: "Where you talk. Starts threads and checks on them through the connector." };
  }
  async send(): Promise<RunRef> {
    return { externalRef: `chat-${randomUUID()}` };
  }
  async followUp(): Promise<void> {}
  async *events(): AsyncIterable<AdapterEvent> {}
  async cancel(): Promise<void> {}
}
