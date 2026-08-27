import crypto from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

export interface IsolationOptions {
  denyNetwork?: boolean;
  seed?: string | number;
  fixedTime?: string | number | Date;
}

export interface IsolationHandle { restore(): void }

export function installIsolation(options: IsolationOptions): IsolationHandle {
  const restorers: Array<() => void> = [];
  if (options.denyNetwork) installNetworkGuard(restorers);
  if (options.seed != null || options.fixedTime != null) installDeterminism(options, restorers);
  syncBuiltinESMExports();
  return { restore: () => { for (const restore of restorers.reverse()) restore(); syncBuiltinESMExports(); } };
}

function installNetworkGuard(restorers: Array<() => void>): void {
  const denied = (..._args: unknown[]): never => { throw new Error("dry-run network isolation blocked an outbound connection"); };
  replace(globalThis as any, "fetch", denied, restorers);
  for (const [module, names] of [
    [http, ["request", "get"]],
    [https, ["request", "get"]],
    [net, ["connect", "createConnection"]],
    [tls, ["connect"]],
    [dgram, ["createSocket"]],
  ] as Array<[Record<string, unknown>, string[]]>) {
    for (const name of names) replace(module, name, denied, restorers);
  }
}

function installDeterminism(options: IsolationOptions, restorers: Array<() => void>): void {
  const seedText = String(options.seed ?? "dry-run");
  let state = hashSeed(seedText) || 0x9e3779b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  replace(Math as any, "random", random, restorers);

  let uuidCounter = 0;
  replace(crypto as any, "randomUUID", () => deterministicUuid(seedText, uuidCounter++), restorers);

  if (options.fixedTime != null) {
    const epoch = new Date(options.fixedTime).getTime();
    if (!Number.isFinite(epoch)) throw new Error(`Invalid fixed time: ${String(options.fixedTime)}`);
    const OriginalDate = Date;
    const FixedDate = function (this: Date, ...args: any[]) {
      if (!new.target) return new OriginalDate(epoch).toString();
      return Reflect.construct(OriginalDate, args.length ? args : [epoch], new.target);
    } as unknown as DateConstructor;
    Object.setPrototypeOf(FixedDate, OriginalDate);
    Object.defineProperty(FixedDate, "prototype", { value: OriginalDate.prototype });
    FixedDate.now = () => epoch;
    (globalThis as any).Date = FixedDate;
    restorers.push(() => { (globalThis as any).Date = OriginalDate; });
  }
}

function replace(target: Record<string, unknown>, key: string, value: unknown, restorers: Array<() => void>): void {
  const original = target[key];
  try {
    target[key] = value;
    restorers.push(() => { target[key] = original; });
  } catch { /* Node permissions still provide the hardened network boundary */ }
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function deterministicUuid(seed: string, counter: number): `${string}-${string}-${string}-${string}-${string}` {
  const hex = crypto.createHash("sha256").update(`${seed}:${counter}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
