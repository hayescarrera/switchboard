// Checks the planner's judgment against the real Claude API. Skipped unless
// ANTHROPIC_API_KEY is set, because each run costs a few cents.

import { describe, expect, it } from "vitest";
import { ClaudePlannerModel } from "../src/planner/claude.js";
import type { PlannerInput } from "../src/planner/model.js";

const thread = (userAnswers: { question: string; answer: string }[] = []): PlannerInput["thread"] => ({
  title: "CSV export",
  goal: "Let users export the reports table as a file.",
  context: {
    plan: "Add an Export button to the reports page that downloads the current table.",
    decisions: ["Export format is CSV, not Excel.", "Dates are written as ISO 8601 (2026-10-12)."],
    constraints: ["No new dependencies."],
    user_answers: userAnswers,
  },
});

const ask = (question: string, userAnswers?: { question: string; answer: string }[]): PlannerInput => ({
  thread: thread(userAnswers),
  history: [{ from: "Planner", to: "Cursor", type: "task", body: "Build the CSV export from the plan." }],
  askedBy: "Cursor",
  question,
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("planner on the live Claude API", () => {
  const model = new ClaudePlannerModel();

  it("answers what the plan settles", async () => {
    const d = await model.decide(ask("What date format should the export use?"));
    expect(d.action).toBe("answer");
    if (d.action === "answer") expect(d.answer).toMatch(/ISO|2026-10-12|YYYY-MM-DD/i);
  }, 120_000);

  it("escalates what the plan leaves open", async () => {
    const d = await model.decide(ask("Should the Export button be visible to read-only users, or only to editors?"));
    expect(d.action).toBe("escalate");
  }, 120_000);

  it("uses the user's earlier answer instead of asking again", async () => {
    const d = await model.decide(ask(
      "Can read-only users see the Export button?",
      [{ question: "Should the Export button be visible to read-only users, or only to editors?", answer: "Everyone, including read-only users." }],
    ));
    expect(d.action).toBe("answer");
  }, 120_000);
});
