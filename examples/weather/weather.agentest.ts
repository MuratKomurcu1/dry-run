import { defineAgent, MockProvider, scenario } from "../../src/index.ts";

const provider = new MockProvider([
  { call: "get_weather", args: { city: "Berlin" } },
  { say: "It is currently sunny in Berlin with a high of 21°C. Perfect day for a walk!" },
]);

const weatherAgent = defineAgent({
  provider,
  system: "You are a helpful weather assistant.",
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  execute: () => ({ temp: 21, condition: "sunny" }),
});

export default [
  scenario({
    name: "weather · answers Berlin question with tool call",
    agent: weatherAgent,
    input: "What's the weather like in Berlin?",
    expect: [
      { type: "toolCalled", tool: "get_weather", times: 1, argsContains: { city: "Berlin" } },
      { type: "notToolCalled", tool: "delete_account" },
      { type: "outputContains", value: "sunny" },
      { type: "outputMatches", pattern: "21°?C" },
      { type: "maxSteps", count: 4 },
    ],
  }),
];
