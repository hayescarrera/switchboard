// What the planner's model sees and what it decides. Kept apart from the Claude
// API so tests can stand in a scripted model, and so other vendors' models
// (Grok, OpenAI) can be the planner later.

import type { MessageType, ThreadContext } from "../types.js";

export interface PlannerInput {
  thread: { title: string; goal: string; context: ThreadContext };
  /** Recent messages on the thread, oldest first, with agent names. */
  history: { from: string; to: string; type: MessageType; body: string }[];
  /** Who is asking. */
  askedBy: string;
  question: string;
}

export type PlannerDecision =
  | {
      action: "answer";
      answer: string;
      /** 0 to 1: how sure the planner is the user would give the same answer. */
      confidence: number;
    }
  | {
      action: "escalate";
      /** One plain question the user can answer without reading the thread. */
      questionForUser: string;
      /** Why the planner couldn't answer on its own. */
      reason: string;
    };

export interface PlannerModel {
  decide(input: PlannerInput): Promise<PlannerDecision>;
}
