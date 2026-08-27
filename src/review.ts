import { createHash } from "node:crypto";
import { AnnotationStore, type AnnotationItem, type AnnotationQueue } from "./team.ts";

export interface ReviewAssignment {
  groupId: string;
  queueId: string;
  target: AnnotationItem["target"];
  items: AnnotationItem[];
  reviewers: string[];
}

export interface ReviewDecision {
  groupId: string;
  state: "pending" | "consensus" | "disagreement" | "adjudication-pending" | "adjudicated";
  completed: number;
  required: number;
  labels: Record<string, number>;
  consensusLabel?: string;
  adjudicationItemId?: string;
}

export interface ReviewerCalibration {
  reviewerId: string;
  rated: number;
  correct: number;
  accuracy: number;
  falsePositive: number;
  falseNegative: number;
}

export interface ReviewAgingReport {
  queueId: string;
  pending: number;
  claimed: number;
  overdue: number;
  oldestAgeHours: number;
  buckets: { underOneHour: number; oneToTwentyFourHours: number; oneToThreeDays: number; overThreeDays: number };
}

export class ReviewWorkflow {
  readonly annotations: AnnotationStore;
  constructor(annotations: AnnotationStore) { this.annotations = annotations; }

  async assign(
    queueId: string,
    target: AnnotationItem["target"],
    options: { reviewerIds?: string[]; priority?: number; labels?: string[]; metadata?: Record<string, unknown>; goldLabel?: string } = {},
  ): Promise<ReviewAssignment> {
    const queue = this.annotations.loadQueue(queueId);
    const pool = uniqueReviewers(options.reviewerIds ?? queue.reviewerIds ?? []);
    const required = queue.mode === "single" || !queue.mode ? 1 : queue.reviewersPerTarget ?? 2;
    if (pool.length < required) throw new Error(`Queue requires ${required} distinct reviewers`);
    const groupId = reviewGroupId(queueId, target);
    const existing = this.groupItems(queueId, groupId);
    if (existing.length) return { groupId, queueId, target: structuredClone(target), items: existing, reviewers: existing.flatMap((item) => item.assignedTo ? [item.assignedTo] : []) };
    const reviewers = selectReviewers(queue, pool, target, required, this.annotations.listItems({ queueId, limit: 10_000 }));
    const items: AnnotationItem[] = [];
    for (const reviewer of reviewers) {
      items.push(await this.annotations.enqueue(queueId, target, {
        priority: options.priority,
        labels: options.labels,
        assignedTo: reviewer,
        metadata: {
          ...(options.metadata ?? {}),
          reviewGroupId: groupId,
          reviewMode: queue.mode ?? "single",
          blind: queue.mode === "double-blind" || queue.mode === "adjudicated",
          ...(options.goldLabel ? { goldLabel: options.goldLabel } : {}),
        },
      }));
    }
    return { groupId, queueId, target: structuredClone(target), items, reviewers };
  }

  decision(queueId: string, groupId: string): ReviewDecision {
    const queue = this.annotations.loadQueue(queueId);
    const items = this.groupItems(queueId, groupId);
    if (!items.length) throw new Error(`Unknown review group: ${groupId}`);
    const required = queue.mode === "single" || !queue.mode ? 1 : queue.reviewersPerTarget ?? 2;
    const completed = items.filter((item) => item.status === "completed" && item.label);
    const labels = counts(completed.flatMap((item) => item.label ? [item.label] : []));
    const adjudication = this.annotations.listItems({ queueId: queue.adjudicationQueueId, limit: 10_000 }).find((item) => item.metadata?.sourceReviewGroupId === groupId);
    if (adjudication?.status === "completed") return { groupId, state: "adjudicated", completed: completed.length, required, labels, ...(adjudication.label ? { consensusLabel: adjudication.label } : {}), adjudicationItemId: adjudication.id };
    if (adjudication) return { groupId, state: "adjudication-pending", completed: completed.length, required, labels, adjudicationItemId: adjudication.id };
    if (completed.length < required) return { groupId, state: "pending", completed: completed.length, required, labels };
    const ordered = Object.entries(labels).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const consensus = ordered.length === 1 || ordered[0][1] > ordered[1][1] ? ordered[0][0] : undefined;
    return { groupId, state: consensus ? "consensus" : "disagreement", completed: completed.length, required, labels, ...(consensus ? { consensusLabel: consensus } : {}) };
  }

  async routeAdjudication(queueId: string, groupId: string): Promise<ReviewDecision> {
    const queue = this.annotations.loadQueue(queueId);
    const decision = this.decision(queueId, groupId);
    if (decision.state !== "disagreement") return decision;
    if (!queue.adjudicationQueueId) throw new Error("Queue does not configure an adjudication queue");
    const source = this.groupItems(queueId, groupId)[0];
    await this.annotations.enqueue(queue.adjudicationQueueId, source.target, {
      priority: source.priority + 1,
      labels: [...new Set(this.groupItems(queueId, groupId).flatMap((item) => item.labels))],
      metadata: { sourceQueueId: queueId, sourceReviewGroupId: groupId, reviewerLabels: decision.labels, adjudication: true },
    });
    return this.decision(queueId, groupId);
  }

  calibration(queueId: string): ReviewerCalibration[] {
    this.annotations.loadQueue(queueId);
    const byReviewer = new Map<string, { rated: number; correct: number; falsePositive: number; falseNegative: number }>();
    for (const item of this.annotations.listItems({ queueId, status: "completed", limit: 10_000 })) {
      const expected = typeof item.metadata?.goldLabel === "string" ? item.metadata.goldLabel : undefined;
      if (!item.assignedTo || !item.label || !expected) continue;
      const current = byReviewer.get(item.assignedTo) ?? { rated: 0, correct: 0, falsePositive: 0, falseNegative: 0 };
      current.rated += 1;
      if (item.label === expected) current.correct += 1;
      else if (positiveLabel(item.label) && !positiveLabel(expected)) current.falsePositive += 1;
      else if (!positiveLabel(item.label) && positiveLabel(expected)) current.falseNegative += 1;
      byReviewer.set(item.assignedTo, current);
    }
    return [...byReviewer.entries()].map(([reviewerId, value]) => ({ reviewerId, ...value, accuracy: value.rated ? value.correct / value.rated : 0 })).sort((left, right) => right.rated - left.rated || left.reviewerId.localeCompare(right.reviewerId));
  }

  aging(queueId: string, now = new Date()): ReviewAgingReport {
    const queue = this.annotations.loadQueue(queueId);
    const items = this.annotations.listItems({ queueId, limit: 10_000 }).filter((item) => item.status === "pending" || item.status === "claimed");
    const ages = items.map((item) => Math.max(0, (now.getTime() - Date.parse(item.createdAt)) / 3_600_000));
    const sla = queue.slaHours ?? 24;
    return {
      queueId,
      pending: items.filter((item) => item.status === "pending").length,
      claimed: items.filter((item) => item.status === "claimed").length,
      overdue: ages.filter((age) => age > sla).length,
      oldestAgeHours: ages.length ? Math.max(...ages) : 0,
      buckets: {
        underOneHour: ages.filter((age) => age < 1).length,
        oneToTwentyFourHours: ages.filter((age) => age >= 1 && age < 24).length,
        oneToThreeDays: ages.filter((age) => age >= 24 && age < 72).length,
        overThreeDays: ages.filter((age) => age >= 72).length,
      },
    };
  }

  blindView(item: AnnotationItem, viewerId: string): AnnotationItem {
    const queue = this.annotations.loadQueue(item.queueId);
    if (!item.metadata?.blind || queue.mode === "single") return structuredClone(item);
    const groupId = String(item.metadata.reviewGroupId ?? "");
    const group = groupId ? this.groupItems(item.queueId, groupId) : [item];
    const allDone = group.every((candidate) => candidate.status === "completed" || candidate.status === "skipped");
    if (allDone || item.assignedTo === viewerId) return structuredClone(item);
    const hidden = structuredClone(item);
    delete hidden.score; delete hidden.label; delete hidden.comment;
    return hidden;
  }

  async bulkComplete(reviewerId: string, decisions: Array<{ id: string; revision: number; score?: number; label?: string; comment?: string; status?: "completed" | "skipped" }>): Promise<{ completed: AnnotationItem[]; conflicts: Array<{ id: string; error: string }> }> {
    if (decisions.length < 1 || decisions.length > 200) throw new Error("Bulk review requires 1-200 decisions");
    const completed: AnnotationItem[] = []; const conflicts: Array<{ id: string; error: string }> = [];
    for (const decision of decisions) {
      try {
        const item = this.annotations.loadItem(decision.id);
        if (item.assignedTo && item.assignedTo !== reviewerId) throw new Error("Review is assigned to another reviewer");
        completed.push(await this.annotations.complete(decision.id, decision, decision.revision));
      } catch (error) { conflicts.push({ id: decision.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { completed, conflicts };
  }

  private groupItems(queueId: string, groupId: string): AnnotationItem[] {
    return this.annotations.listItems({ queueId, limit: 10_000 }).filter((item) => item.metadata?.reviewGroupId === groupId);
  }
}

function reviewGroupId(queueId: string, target: AnnotationItem["target"]): string {
  return `review_${createHash("sha256").update(`${queueId}\0${target.type}\0${target.id}\0${target.subId ?? ""}`).digest("hex").slice(0, 32)}`;
}
function uniqueReviewers(values: string[]): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 128)) throw new Error("Reviewer IDs must contain 1-128 characters");
  return [...new Set(values.map((value) => value.trim()))];
}
function selectReviewers(queue: AnnotationQueue, reviewers: string[], target: AnnotationItem["target"], count: number, existing: AnnotationItem[]): string[] {
  if ((queue.assignment ?? "manual") === "round-robin") {
    const load = new Map(reviewers.map((reviewer) => [reviewer, existing.filter((item) => item.assignedTo === reviewer && !["completed", "skipped"].includes(item.status)).length]));
    return [...reviewers].sort((left, right) => load.get(left)! - load.get(right)! || left.localeCompare(right)).slice(0, count);
  }
  if (queue.assignment === "deterministic-random") {
    return [...reviewers].sort((left, right) => hash(`${target.type}:${target.id}:${left}`).localeCompare(hash(`${target.type}:${target.id}:${right}`))).slice(0, count);
  }
  return reviewers.slice(0, count);
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function counts(values: string[]): Record<string, number> { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return result; }
function positiveLabel(value: string): boolean { return /^(?:pass|passed|yes|true|correct|approved|safe|positive)$/i.test(value); }
