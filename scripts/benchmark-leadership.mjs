#!/usr/bin/env node
import { cpus, platform, release, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import {
  AnnotationStore,
  CassetteStore,
  OnlineEvaluationEngine,
  OnlineEvaluationProcessor,
  OnlineEvaluationStore,
  RegressionStore,
  TraceStore,
  defineAgent,
  replayer,
  runScenarios,
  scenario,
} from "../dist/index.js";

const args = process.argv.slice(2);
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageName = String(packageMetadata.name);
const packageVersion = String(packageMetadata.version);
const traceCount = integer("--traces", 200, 1, 2_000);
const iterations = integer("--iterations", 7, 3, 100);
const promotionCount = integer("--promotions", 100, 1, 2_000);
const mutationCount = integer("--mutations", 600, 3, 100_000);
const replayCount = integer("--replays", 500, 1, 100_000);
const output = value("--output");
const bootstrapResamples = integer("--bootstrap", 10_000, 1_000, 100_000);
const seed = integer("--seed", 8_026, 1, 2_147_483_647);
const root = mkdtempSync(path.join(tmpdir(), "dryrun-leadership-bench-"));

try {
  const replay = await benchmarkReplay();
  const closedLoop = await benchmarkClosedLoop();
  const promotion = await benchmarkPromotion();
  const integrity = benchmarkIntegrity(promotion.fixture);
  const isolation = verifyNetworkDeniedCli();
  const document = {
    schema: "dry-run.leadership-benchmark.v1",
    createdAt: new Date().toISOString(),
    package: packageName,
    version: packageVersion,
    runtime: {
      node: process.version,
      os: `${platform()} ${release()}`,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
    },
    configuration: { traceCount, iterations, promotionCount, mutationCount, replayCount, bootstrapResamples, seed },
    claims: {
      deterministicOfflineReplay: replay,
      productionToReviewLoop: closedLoop,
      traceToExecutableRegression: withoutFixture(promotion),
      artifactIntegrity: integrity,
    },
    isolation,
    limitations: [
      "This is a Dry Run implementation benchmark, not a synthetic speed comparison against hosted products.",
      "Leadership labels are limited to the exact documented workflows; they do not imply overall product, UI, adoption, or hosted-scale leadership.",
      "Filesystem, CPU power mode, Node version, payload size, and background load affect latency and throughput.",
      "The closed-loop fixture uses deterministic checks and one LLM span; semantic judge latency is intentionally excluded.",
      "Wilson intervals describe observed binary correctness rates. Bootstrap intervals describe this machine's sampled medians, not universal performance.",
    ],
  };
  validateClaims(document);
  const rendered = `${JSON.stringify(document, null, 2)}\n`;
  if (output) {
    const target = path.resolve(output);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, rendered, { flag: "wx" });
  }
  process.stdout.write(rendered);
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function benchmarkReplay() {
  const store = new CassetteStore(path.join(root, "replay"));
  store.saveSync("leadership", [{ request: { model: "offline", messages: [{ role: "user", content: "refund order 42" }] }, response: { text: "refund approved", toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 } } }]);
  const execute = async () => {
    const cases = Array.from({ length: replayCount }, (_, index) => scenario({
      name: `leadership-replay-${index}`,
      agent: defineAgent({ provider: replayer(store, "leadership"), model: "offline" }),
      input: "refund order 42",
      expect: [{ type: "outputEquals", value: "refund approved" }],
    }));
    return runScenarios(cases);
  };
  await execute();
  await execute();
  const samplesMs = [];
  let successful = 0;
  const attempted = replayCount * iterations;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const started = performance.now();
    const summary = await execute();
    samplesMs.push(performance.now() - started);
    successful += summary.passed;
    if (summary.failed) throw new Error(`replay correctness failure in iteration ${iteration}`);
  }
  const throughput = samplesMs.map((elapsed) => replayCount / (elapsed / 1_000));
  return {
    definition: "Checksum-verified canonical model replay plus output assertion, with a fresh replayer per scenario and no provider call.",
    attempted,
    successful,
    correctnessRate: rateWithWilson(successful, attempted),
    suiteLatencyMs: distribution(samplesMs),
    scenariosPerSecond: distribution(throughput),
    medianLatencyBootstrap95: bootstrapMedianCI(samplesMs, bootstrapResamples, seed + 1),
    providerNetworkCalls: 0,
    providerCostUsd: 0,
  };
}

async function benchmarkClosedLoop() {
  const samplesMs = [];
  const idempotentSamplesMs = [];
  let evaluated = 0;
  let reviewItems = 0;
  let duplicateReviewItems = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const iterationRoot = path.join(root, `loop-${iteration}`);
    const traces = new TraceStore(path.join(iterationRoot, "traces"));
    const online = new OnlineEvaluationStore(path.join(iterationRoot, "online"));
    const annotations = new AnnotationStore(path.join(iterationRoot, "annotations"));
    await online.create({ name: "Production latency guard", filter: { tags: ["production"], sampleRate: 1 }, checks: [{ type: "maxDuration", ms: 50 }, { type: "noToolErrors" }], action: { queueName: "Production failures" } });
    const documents = Array.from({ length: traceCount }, (_, index) => traceDocument(`loop_${iteration}_${index}`, index));
    const engine = new OnlineEvaluationEngine(online, { annotations });
    const processor = new OnlineEvaluationProcessor(online, traces, engine);
    const started = performance.now();
    for (const trace of documents) await traces.export(trace);
    await processor.enqueue(documents.map((trace) => trace.id));
    await processor.drain();
    samplesMs.push(performance.now() - started);
    const results = online.listResults({ limit: traceCount });
    const queue = annotations.listQueues()[0];
    const items = queue ? annotations.listItems({ queueId: queue.id, limit: 10_000 }) : [];
    evaluated += results.length;
    reviewItems += items.length;
    const retryStarted = performance.now();
    const retry = await engine.evaluateMany(documents);
    idempotentSamplesMs.push(performance.now() - retryStarted);
    const afterRetry = queue ? annotations.listItems({ queueId: queue.id, limit: 10_000 }) : [];
    duplicateReviewItems += Math.max(0, afterRetry.length - items.length);
    if (results.length !== traceCount || items.length !== traceCount || retry.cached !== traceCount) throw new Error(`closed-loop correctness failure in iteration ${iteration}`);
  }
  const attempted = traceCount * iterations;
  const throughput = samplesMs.map((elapsed) => traceCount / (elapsed / 1_000));
  return {
    definition: "Persist trace, enqueue durable leased job, evaluate revisioned deterministic rule, persist result, and mine one deduplicated human-review item.",
    attempted,
    evaluated,
    reviewItems,
    successRate: rateWithWilson(Math.min(evaluated, reviewItems), attempted),
    duplicateReviewItems,
    duplicateRate: rateWithWilson(duplicateReviewItems, attempted),
    endToEndSuiteLatencyMs: distribution(samplesMs),
    tracesPerSecond: distribution(throughput),
    medianLatencyBootstrap95: bootstrapMedianCI(samplesMs, bootstrapResamples, seed + 2),
    idempotentRerunLatencyMs: distribution(idempotentSamplesMs),
    providerNetworkCalls: 0,
    providerCostUsd: 0,
  };
}

async function benchmarkPromotion() {
  const store = new RegressionStore(path.join(root, "regressions"));
  const durationsMs = [];
  let completeBundles = 0;
  let verifiedBundles = 0;
  let fixture;
  for (let index = 0; index < promotionCount; index++) {
    const started = performance.now();
    const bundle = await store.promote(traceDocument(`promotion_${index}`, index), { name: `production regression ${index}`, onlineResultId: `online_${index}`, annotationItemId: `annotation_${index}` });
    durationsMs.push(performance.now() - started);
    if (bundle.dataset.cases.length === 1 && bundle.cassette?.interactions.length === 1 && bundle.scenario && bundle.manifest.warnings.length === 0) completeBundles += 1;
    const loaded = store.load(bundle.manifest.id);
    if (loaded.manifest.dataset.checksum === bundle.dataset.checksum && loaded.manifest.cassette?.checksum === bundle.cassette?.checksum && loaded.scenario === bundle.scenario) verifiedBundles += 1;
    fixture ??= { store, bundle };
  }
  return {
    definition: "Convert one production trace into an attributed checksummed dataset, canonical cassette, generated executable agent test, and verified manifest.",
    attempted: promotionCount,
    completeBundles,
    verifiedBundles,
    completeBundleRate: rateWithWilson(completeBundles, promotionCount),
    verifiedBundleRate: rateWithWilson(verifiedBundles, promotionCount),
    latencyMs: distribution(durationsMs),
    medianLatencyBootstrap95: bootstrapMedianCI(durationsMs, bootstrapResamples, seed + 3),
    artifactsPerBundle: 4,
    fixture,
  };
}

function benchmarkIntegrity(fixture) {
  const bundleRoot = path.join(fixture.store.dir, fixture.bundle.manifest.id);
  const files = {
    dataset: path.join(bundleRoot, "dataset.json"),
    cassette: path.join(bundleRoot, "cassette.json"),
    scenario: path.join(bundleRoot, "regression.agentest.ts"),
  };
  const originals = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, readFileSync(file, "utf8")]));
  const byArtifact = { dataset: { attempted: 0, detected: 0 }, cassette: { attempted: 0, detected: 0 }, scenario: { attempted: 0, detected: 0 } };
  const order = ["dataset", "cassette", "scenario"];
  for (let index = 0; index < mutationCount; index++) {
    const artifact = order[index % order.length];
    const file = files[artifact];
    byArtifact[artifact].attempted += 1;
    writeFileSync(file, mutate(artifact, originals[artifact], index));
    try { fixture.store.load(fixture.bundle.manifest.id); }
    catch { byArtifact[artifact].detected += 1; }
    finally { writeFileSync(file, originals[artifact]); }
  }
  const detected = Object.values(byArtifact).reduce((total, item) => total + item.detected, 0);
  return {
    definition: "Change one persisted dataset, cassette, or generated-test payload without updating its trusted checksum, then load the regression bundle.",
    attempted: mutationCount,
    detected,
    detectionRate: rateWithWilson(detected, mutationCount),
    falseNegatives: mutationCount - detected,
    byArtifact: Object.fromEntries(Object.entries(byArtifact).map(([name, item]) => [name, { ...item, detectionRate: rateWithWilson(item.detected, item.attempted) }])),
    mutationModel: "Semantics-preserving JSON value changes for dataset/cassette; deterministic single-character source changes for generated tests.",
  };
}

function mutate(artifact, source, index) {
  if (artifact === "dataset") {
    const value = JSON.parse(source);
    value.cases[0].expected = `${String(value.cases[0].expected)} mutation-${index}`;
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  if (artifact === "cassette") {
    const value = JSON.parse(source);
    value.interactions[0].response.text = `${String(value.interactions[0].response.text)} mutation-${index}`;
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  const candidates = [...source].map((character, position) => ({ character, position })).filter(({ character }) => /[A-Za-z]/.test(character));
  const selected = candidates[index % candidates.length];
  const replacement = selected.character === "z" ? "y" : selected.character === "Z" ? "Y" : String.fromCharCode(selected.character.charCodeAt(0) + 1);
  return `${source.slice(0, selected.position)}${replacement}${source.slice(selected.position + 1)}`;
}

function verifyNetworkDeniedCli() {
  const result = spawnSync(process.execPath, ["dist/cli.js", "run", "examples", "--replay", "--deny-network"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (result.status !== 0) throw new Error(`network-denied CLI verification failed:\n${result.stderr || result.stdout}`);
  return { command: "node dist/cli.js run examples --replay --deny-network", passed: true, exitCode: result.status, boundaryReported: /network isolation/i.test(result.stderr) };
}

function traceDocument(id, index) {
  const startedAt = new Date(Date.UTC(2026, 7, 26, 8, 0, 0, index % 1_000)).toISOString();
  const endedAt = new Date(Date.parse(startedAt) + 100 + index % 25).toISOString();
  return {
    kind: "dry-run.trace", version: 1, id, name: "support-production", status: "ok", startedAt, endedAt, durationMs: 100 + index % 25,
    rootSpanId: `root_${id}`, tags: ["production"], metadata: { environment: "production", release: `v${packageVersion}` }, feedback: [],
    spans: [
      { id: `root_${id}`, traceId: id, name: "support-production", type: "agent", status: "ok", startedAt, endedAt, durationMs: 100 + index % 25, input: `refund order ${index}`, output: "refund approved", attributes: {}, metrics: {}, events: [] },
      { id: `llm_${id}`, traceId: id, parentId: `root_${id}`, name: "local-model", type: "llm", status: "ok", startedAt, endedAt, durationMs: 80, input: { model: "local", messages: [{ role: "user", content: `refund order ${index}` }] }, output: { text: "refund approved", toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 } }, attributes: { "gen_ai.request.model": "local" }, metrics: {}, events: [] },
    ],
  };
}

function validateClaims(document) {
  const claims = document.claims;
  if (claims.deterministicOfflineReplay.successful !== claims.deterministicOfflineReplay.attempted) throw new Error("replay leadership gate failed");
  if (claims.productionToReviewLoop.evaluated !== claims.productionToReviewLoop.attempted || claims.productionToReviewLoop.reviewItems !== claims.productionToReviewLoop.attempted || claims.productionToReviewLoop.duplicateReviewItems !== 0) throw new Error("closed-loop leadership gate failed");
  if (claims.traceToExecutableRegression.completeBundles !== claims.traceToExecutableRegression.attempted || claims.traceToExecutableRegression.verifiedBundles !== claims.traceToExecutableRegression.attempted) throw new Error("promotion leadership gate failed");
  if (claims.artifactIntegrity.detected !== claims.artifactIntegrity.attempted) throw new Error("integrity leadership gate failed");
  if (!document.isolation.passed || !document.isolation.boundaryReported) throw new Error("network isolation leadership gate failed");
}

function withoutFixture(value) { const { fixture: _fixture, ...rest } = value; return rest; }
function value(name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function integer(name, fallback, minimum, maximum) { const parsed = value(name) == null ? fallback : Number(value(name)); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return parsed; }
function distribution(values) { const sorted = [...values].sort((a, b) => a - b); return { samples: values.map(round), count: values.length, min: round(sorted[0] ?? 0), median: round(percentile(sorted, .5)), p95: round(percentile(sorted, .95)), p99: round(percentile(sorted, .99)), max: round(sorted.at(-1) ?? 0) }; }
function percentile(sorted, q) { return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0; }
function round(value) { return Math.round(value * 100) / 100; }
function roundRate(value) { return Math.round(value * 1_000_000) / 1_000_000; }

function rateWithWilson(successes, total) {
  if (!total) return { successes, total, rate: 0, confidence95: { low: 0, high: 0 } };
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { successes, total, rate: roundRate(p), confidence95: { low: roundRate(Math.max(0, center - margin)), high: roundRate(Math.min(1, center + margin)) } };
}

function bootstrapMedianCI(values, resamples, initialSeed) {
  let state = initialSeed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
  const medians = [];
  for (let sample = 0; sample < resamples; sample++) {
    const selected = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]).sort((a, b) => a - b);
    medians.push(percentile(selected, .5));
  }
  medians.sort((a, b) => a - b);
  return { method: "seeded nonparametric bootstrap", resamples, low: round(percentile(medians, .025)), high: round(percentile(medians, .975)) };
}
