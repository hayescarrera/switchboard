// Shared types for the hub. Field names follow CLAUDE.md section 6.1.

export const MESSAGE_TYPES = ["task", "question", "answer", "status", "result"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Types the receiving side may send back along a line it was reached on. */
export const REPLY_TYPES: readonly MessageType[] = ["question", "answer", "status", "result"];

export type AgentKind = "a2a_native" | "adapter" | "hub_run" | "human";
export type ThreadStatus = "active" | "waiting_on_user" | "done" | "blocked";
export type RunState = "running" | "done" | "error" | "timed_out" | "cancelled";

/** The shared context every agent in a thread works from. */
export interface ThreadContext {
  summary?: string;
  plan?: string;
  decisions?: string[];
  constraints?: string[];
  open_questions?: string[];
  links?: string[];
  user_answers?: { question: string; answer: string }[];
  [field: string]: unknown;
}

export interface AgentCard {
  name: string;
  description?: string;
  skills?: { id: string; name: string; description?: string }[];
}

export interface User {
  id: string;
  name: string;
  contact: string | null;
}

export interface Agent {
  id: string;
  name: string;
  vendor: string;
  kind: AgentKind;
  adapter: string;
  card: AgentCard;
  owner_user_id: string;
  status: "active" | "disabled";
}

export interface Line {
  id: string;
  from_node: string;
  to_node: string;
  allowed_types: MessageType[];
  context_scope: string[];
  enabled: boolean;
}

export interface Thread {
  id: string;
  title: string;
  goal: string;
  participants: string[];
  context: ThreadContext;
  status: ThreadStatus;
  status_reason: string | null;
  message_count: number;
  max_messages: number;
}

export interface Message {
  id: string;
  thread_id: string;
  line_id: string;
  from_agent: string;
  to_agent: string;
  type: MessageType;
  body: string;
  context: ThreadContext;
  created_at: Date;
}

export interface Run {
  id: string;
  agent_id: string;
  thread_id: string;
  line_id: string;
  requester_id: string;
  external_ref: string | null;
  state: RunState;
  last_event_at: Date;
  timeout_seconds: number;
  nudged_at: Date | null;
}

export interface HubEvent {
  id: string;
  at: Date;
  kind: string;
  thread_id: string | null;
  agent_id: string | null;
  line_id: string | null;
  run_id: string | null;
  message_id: string | null;
  data: Record<string, unknown>;
}
