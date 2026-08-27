export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
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
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  responseFormat?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  costUsd?: number;
  finishReason?: string;
  providerMetadata?: Record<string, unknown>;
  streamEvents?: ChatStreamEvent[];
}

export interface ChatStreamEvent {
  type: "text-delta" | "tool-call";
  textDelta?: string;
  toolCall?: ToolCall;
  offsetMs?: number;
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
  durationMs?: number;
  costUsd?: number;
}

export interface Trajectory {
  steps: Step[];
  output: string;
}

export interface AgentRunContext {
  signal: AbortSignal;
  trial: number;
}

export type TestAgent = (input: string, context?: AgentRunContext) => Promise<Trajectory>;

export type TrajectoryMatchMode = "strict" | "unordered" | "subset" | "superset";

export type CustomAssertionValue =
  | boolean
  | string
  | AssertionResult
  | Promise<boolean | string | AssertionResult>;

export type Assertion =
  | { type: "toolCalled"; tool: string; times?: number; argsContains?: Record<string, unknown> }
  | { type: "notToolCalled"; tool: string }
  | { type: "outputEquals"; value: string }
  | { type: "outputContains"; value: string }
  | { type: "outputMatches"; pattern: string; flags?: string }
  | { type: "maxSteps"; count: number }
  | { type: "maxTokens"; count: number }
  | { type: "maxLLMCalls"; count: number }
  | { type: "maxDuration"; ms: number }
  | { type: "maxCost"; usd: number }
  | { type: "noRepeatedToolCalls"; limit?: number }
  | { type: "noToolErrors" }
  | { type: "toolOrder"; tools: string[]; exact?: boolean }
  | { type: "toolArgsSchema"; tool: string; schema: Record<string, unknown>; every?: boolean }
  | { type: "outputJsonSchema"; schema: Record<string, unknown> }
  | { type: "trajectory"; tools: string[]; mode?: TrajectoryMatchMode }
  | { type: "custom"; name: string; evaluate: (trajectory: Trajectory) => CustomAssertionValue }
  | { type: "semantic"; criteria: string };

export interface Scenario {
  name: string;
  agent: TestAgent;
  input: string;
  expect: Assertion[];
  timeoutMs?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  retries?: number;
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
  costUsd?: number;
  trial?: number;
  attempts?: number;
  tags?: string[];
  error?: string;
}

export interface RunSummary {
  results: ScenarioResult[];
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
}
