// A stand-in for the planner's Claude model, for running the hub without an
// ANTHROPIC_API_KEY. It is not smart: it answers when one of your decisions or
// earlier answers shares a word with the question, and asks you otherwise.

import type { PlannerDecision, PlannerInput, PlannerModel } from "./model.js";

const STOP = new Set(["should", "would", "could", "which", "there", "their", "about", "these", "those", "before", "start"]);
const keywords = (text: string) =>
  new Set(text.toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !STOP.has(w)) ?? []);

export class StandInPlannerModel implements PlannerModel {
  async decide(input: PlannerInput): Promise<PlannerDecision> {
    const asked = keywords(input.question);
    const overlaps = (text: string) => [...keywords(text)].some((w) => asked.has(w));
    const ctx = input.thread.context;
    const fromUser = ctx.user_answers?.find((a) => overlaps(a.question));
    if (fromUser) return { action: "answer", answer: fromUser.answer, confidence: 0.95 };
    const decision = ctx.decisions?.find(overlaps) ?? ctx.constraints?.find(overlaps);
    if (decision) return { action: "answer", answer: `From the plan: ${decision}`, confidence: 0.9 };
    return { action: "escalate", questionForUser: input.question, reason: "The plan doesn't say." };
  }
}
