import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider error redaction", () => {
  it("redacts secret-shaped OpenAI error bodies", async () => {
    const providerSecret = ["sk", "live", "abcdefghijklmnop"].join("-");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`invalid key ${providerSecret}`, { status: 401 }),
      ),
    );
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const call = provider.chat({ model: "test", messages: [] });
    await expect(call).rejects.toThrow("[REDACTED]");
    await expect(call).rejects.not.toThrow("sk-live-");
  });

  it("redacts secret-shaped Anthropic error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(`authorization ${["Bearer", "abcdefghijklmnopqrstuvwxyz"].join(" ")}`, { status: 403 }),
      ),
    );
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const call = provider.chat({ model: "test", messages: [] });
    await expect(call).rejects.toThrow("[REDACTED]");
    await expect(call).rejects.not.toThrow("Bearer abc");
  });
});
