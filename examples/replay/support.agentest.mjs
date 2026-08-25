import { fileURLToPath } from "node:url";
import {
  autoCassette,
  defineAgent,
  scenario,
} from "@muratkomurcu/dry-run";

const cassetteDir = fileURLToPath(new URL("./cassettes", import.meta.url));
const unavailableLiveProvider = () => {
  throw new Error("This example must replay its committed cassette; no live provider is configured.");
};

const provider = autoCassette("support-flow", unavailableLiveProvider, {
  dir: cassetteDir,
});

const supportAgent = defineAgent({
  provider,
  model: "recorded-provider",
  system: "You are a careful support agent.",
  tools: [
    {
      name: "lookup_order",
      description: "Look up an order",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "issue_refund",
      description: "Refund an eligible order",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  ],
  execute: (call) => {
    if (call.name === "lookup_order") {
      return { id: "1234", status: "paid", eligible: true };
    }
    throw new Error(`Unexpected tool call: ${call.name}`);
  },
});

export default [
  scenario({
    name: "support · replays a recorded trajectory offline",
    agent: supportAgent,
    input: "Please refund order #1234",
    expect: [
      { type: "toolCalled", tool: "lookup_order", times: 1, argsContains: { id: "1234" } },
      { type: "notToolCalled", tool: "issue_refund" },
      { type: "outputContains", value: "eligible" },
      { type: "maxSteps", count: 3 },
      { type: "maxTokens", count: 200 },
    ],
  }),
];
