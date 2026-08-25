export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
}

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

export interface LLMProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface Step {
  kind: "llm" | "tool";
  response?: string;
  usage?: TokenUsage;
  toolCall?: ToolCall;
  result?: unknown;
  error?: string;
}

export interface Trajectory {
  steps: Step[];
  output: string;
}

export type TestAgent = (input: string) => Promise<Trajectory>;

export type Assertion =
  | { type: "toolCalled"; tool: string; times?: number; argsContains?: Record<string, unknown> }
  | { type: "notToolCalled"; tool: string }
  | { type: "outputEquals"; value: string }
  | { type: "outputContains"; value: string }
  | { type: "outputMatches"; pattern: string; flags?: string }
  | { type: "maxSteps"; count: number }
  | { type: "maxTokens"; count: number }
  | { type: "noRepeatedToolCalls"; limit?: number }
  | { type: "semantic"; criteria: string };

export interface Scenario {
  name: string;
  agent: TestAgent;
  input: string;
  expect: Assertion[];
  timeoutMs?: number;
}

export interface AssertionResult {
  label: string;
  passed: boolean;
  skipped?: boolean;
  message?: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  assertions: AssertionResult[];
  durationMs: number;
  tokens?: number;
  error?: string;
}

export interface RunSummary {
  results: ScenarioResult[];
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
}
