import {
  Dataset,
  exactMatchScorer,
  groundednessScorer,
  toolCorrectnessScorer,
} from "@muratkomurcu/dry-run";

const dataset = Dataset.create("support-policy", [
  {
    id: "refund-window",
    input: "How long do I have to request a refund?",
    expected: "30 days",
    retrievalContext: ["Refunds are available for 30 days after purchase."],
    expectedTools: [{ name: "search_policy", arguments: { topic: "refund" } }],
    tags: ["support", "rag"],
  },
]);

export default {
  name: "offline-support-quality",
  dataset,
  task: async () => ({
    steps: [
      {
        kind: "tool",
        toolCall: { id: "call_1", name: "search_policy", arguments: { topic: "refund" } },
        result: "Refunds are available for 30 days after purchase.",
      },
      { kind: "llm", response: "30 days" },
    ],
    output: "30 days",
  }),
  scorers: [exactMatchScorer(), groundednessScorer(), toolCorrectnessScorer()],
  tags: ["example", "offline"],
};
