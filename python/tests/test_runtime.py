import asyncio
import json
import os
import sys
import tempfile
import unittest
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

from dryrun import (
    RED_TEAM_ATTACKS,
    RED_TEAM_VULNERABILITIES,
    CassetteStore,
    Replayer,
    Scenario,
    bleu,
    citation_completeness,
    generate_adversarial_cases,
    retrieval_average_precision,
    run_scenarios,
    token_f1,
    CallableJudge,
    ConsensusJudge,
    JudgeRequest,
    ConversationalTestCase,
    MetricDag,
    MetricDagNode,
    MetricSuite,
    Turn,
    answer_relevancy,
    calibrate_metric,
    contextual_recall,
    conversation_goal_completion,
    cross_modal_consistency,
    media_integrity,
    pii_safety,
    tool_correctness,
    task_completion,
    ExperimentCase,
    ExperimentDefinition,
    FileTraceExporter,
    TeamClient,
    TeamClientOptions,
    Tracer,
    instrument_openai,
    run_experiment,
)


class RuntimeTest(unittest.TestCase):
    def test_legacy_replay_and_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "demo.json"
            file.write_text(json.dumps([{
                "request": {"model": "demo", "messages": [{"role": "user", "content": "hi"}]},
                "response": {"text": "hello", "toolCalls": []},
            }]), encoding="utf-8")
            self.assertEqual(CassetteStore(file).load()["version"], 2)
            replay = Replayer(file)

            async def agent(text):
                response = await replay.chat({"model": "demo", "messages": [{"role": "user", "content": text}]})
                return {"steps": [{"kind": "llm", "response": response["text"]}], "output": response["text"]}

            summary = asyncio.run(run_scenarios([
                Scenario(name="python replay", agent=agent, input="different wording", expect=[{"type": "outputEquals", "value": "hello"}])
            ]))
            self.assertEqual(summary["failed"], 0)

    def test_dependency_free_deterministic_metrics(self):
        self.assertAlmostEqual(token_f1("alpha beta gamma", "alpha beta beta").score, 2 / 3)
        self.assertEqual(bleu("alpha beta", "alpha beta").score, 1)
        self.assertAlmostEqual(retrieval_average_precision(["noise", "a", "b"], ["a", "b"], k=3).score, 7 / 12)
        self.assertEqual(citation_completeness("Supported [1].", ["[1]", "[2]"]).score, 0.5)

    def test_python_red_team_catalog_matches_typescript_surface(self):
        self.assertEqual(len(RED_TEAM_ATTACKS), 40)
        self.assertEqual(len(RED_TEAM_VULNERABILITIES), 15)
        generated = generate_adversarial_cases([{"id": "safe", "input": "help", "expected": "safe"}])
        self.assertEqual(len(generated), 40)
        self.assertEqual(len({item["metadata"]["redTeam"]["vulnerability"] for item in generated}), 15)
        encoded = generate_adversarial_cases([{"input": "help"}], vulnerabilities=["encoding-bypass"])
        self.assertEqual(len(encoded), 9)

    def test_advanced_rag_agent_multimodal_and_safety_metrics(self):
        self.assertEqual(contextual_recall("refund in thirty days", ["Refund requests are accepted in thirty days."]).score, 1)
        self.assertTrue(tool_correctness(
            [{"name": "search", "arguments": {"query": "refund", "limit": 3}}],
            [{"name": "search", "arguments": {"query": "refund"}}],
        ).passed)
        media = [
            {"id": "receipt", "kind": "image", "mimeType": "image/png", "sha256": "sha256:" + "a" * 64, "ocrText": "order 42"},
            {"id": "call", "kind": "audio", "mimeType": "audio/wav", "sha256": "sha256:" + "b" * 64, "transcript": "order 42"},
        ]
        self.assertTrue(media_integrity(media).passed)
        self.assertEqual(cross_modal_consistency(media).score, 1)
        self.assertFalse(pii_safety("Contact ada@example.com").passed)

    def test_free_local_semantic_judge_suite_and_conversation_dag(self):
        async def judge(request):
            score = 1.0 if request.parameters else 0.0
            return {"score": score, "reason": f"evaluated {request.name}", "evidence": ["deterministic-test-judge"]}

        semantic_judge = CallableJudge(judge)
        case = ConversationalTestCase(
            scenario="Resolve a delayed order",
            expected_outcome="User receives a resolution",
            chatbot_role="support specialist",
            turns=[Turn("user", "Order 42 is late"), Turn("assistant", "I will replace order 42")],
        )
        relevance = answer_relevancy(semantic_judge)
        goal = conversation_goal_completion(semantic_judge)
        suite = MetricSuite([goal], concurrency=2)
        suite_results = asyncio.run(suite.measure(case))
        self.assertTrue(suite_results[0].passed)

        dag = MetricDag("release", [
            MetricDagNode("relevance", relevance),
            MetricDagNode("goal", goal, depends_on=("relevance",)),
        ])
        mapping_case = {"input": "Where is order 42?", "actual_output": "I will replace it", "turns": [vars(turn) for turn in case.turns], "expected_outcome": case.expected_outcome}
        result = asyncio.run(dag.measure(mapping_case))
        self.assertTrue(result.passed)
        self.assertEqual(len(result.details["nodes"]), 2)

    def test_consensus_judge_calibration_and_expanded_semantic_catalog(self):
        judges = [CallableJudge(lambda _request, score=score: {"score": score, "reason": "fixture"}) for score in (0.8, 0.9, 0.85)]
        consensus = ConsensusJudge(judges, max_spread=0.2)
        metric = task_completion(consensus, threshold=0.7)
        cases = [
            ({"input": "refund order", "actual_output": "refund complete", "tools_called": [{"name": "refund"}]}, True),
            ({"input": "refund order", "actual_output": "refund complete", "tools_called": [{"name": "refund"}]}, True),
        ]
        report = asyncio.run(calibrate_metric(metric, cases, bins=5))
        self.assertEqual(report["samples"], 2)
        self.assertEqual(report["accuracy"], 1)
        self.assertEqual(report["confusion"]["truePositive"], 2)
        self.assertGreater(report["brierScore"], 0)
        disputed = ConsensusJudge([CallableJudge(lambda _request: {"score": 0.1}), CallableJudge(lambda _request: {"score": 0.9})], max_spread=0.2)
        disputed_result = asyncio.run(disputed.evaluate(JudgeRequest("x", "x", {"x": 1})))
        self.assertEqual(disputed_result["score"], 0)
        self.assertFalse(disputed_result["agreement"]["agreed"])

    def test_python_tracing_experiment_and_framework_instrumentation(self):
        with tempfile.TemporaryDirectory() as directory:
            tracer = Tracer([FileTraceExporter(Path(directory) / "traces")])
            with tracer.start_span("support-agent", span_type="agent", input="refund") as root:
                with tracer.start_span("lookup", span_type="tool", input={"id": 42}) as tool:
                    tool.set_output({"eligible": True})
                root.set_output("approved")
            self.assertEqual(len(tracer.completed), 1)
            trace = next(iter(tracer.completed.values()))
            self.assertEqual([span["type"] for span in trace["spans"]], ["agent", "tool"])
            self.assertEqual(len(list((Path(directory) / "traces").glob("*.json"))), 1)

            async def task(value, context):
                return str(value).upper()
            def exact(context):
                return {"name": "exact", "score": 1 if context["output"] == context["expected"] else 0, "passed": context["output"] == context["expected"]}
            experiment = asyncio.run(run_experiment(ExperimentDefinition("python-quality", [ExperimentCase("a", "A"), ExperimentCase("b", "B")], task, [exact]), trials=2, store=Path(directory) / "experiments"))
            self.assertEqual(experiment["summary"]["passed"], 4)
            self.assertEqual(experiment["aggregates"][0]["passRate"], 1)

            class Completions:
                def create(self, **kwargs): return {"output": "ok", "usage": {"total_tokens": 3}}
            class Chat: pass
            class Client: pass
            client = Client(); client.chat = Chat(); client.chat.completions = Completions(); client.responses = None
            instrument_openai(client, tracer)
            self.assertEqual(client.chat.completions.create(model="local")["output"], "ok")
            self.assertEqual(len(tracer.completed), 2)

    def test_dependency_free_team_client_uses_idempotent_trace_put(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):
                length = int(self.headers.get("Content-Length", "0")); body = json.loads(self.rfile.read(length)); requests.append((self.path, self.headers.get("Authorization"), body))
                payload = json.dumps({"accepted": 1, "ids": [body["id"]]}).encode(); self.send_response(202); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler); thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            client = TeamClient(TeamClientOptions(endpoint=f"http://127.0.0.1:{server.server_port}", token="drk_abcdefgh_abcdefghijklmnopqrstuvwxyz", project="production"))
            trace = {"id": "trace_python", "kind": "dry-run.trace", "version": 1}
            self.assertEqual(client.put_trace(trace)["accepted"], 1)
            self.assertEqual(requests[0][0], "/api/v1/projects/production/traces/trace_python")
            self.assertTrue(requests[0][1].startswith("Bearer drk_"))
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
