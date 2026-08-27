#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const output = path.resolve(value("--output") ?? "sbom.cdx.json");
const lock = JSON.parse(await readFile(path.resolve("package-lock.json"), "utf8"));
const root = lock.packages?.[""];
if (!root?.name || !root.version || !lock.packages) throw new Error("package-lock.json does not contain a lockfile v2/v3 package graph");

const components = [];
const refs = new Map();
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location || !location.startsWith("node_modules/") || !pkg?.version) continue;
  const name = location.slice(location.lastIndexOf("node_modules/") + 13);
  const ref = `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(pkg.version)}`;
  refs.set(location, ref);
  const hashes = integrityHashes(pkg.integrity);
  components.push({ type: "library", "bom-ref": ref, name, version: pkg.version, ...(pkg.license ? { licenses: [{ license: { id: String(pkg.license) } }] } : {}), ...(hashes.length ? { hashes } : {}), purl: ref, properties: [{ name: "dryrun:dev", value: String(Boolean(pkg.dev)) }, { name: "dryrun:optional", value: String(Boolean(pkg.optional)) }] });
}
components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
const rootRef = `pkg:npm/${encodeURIComponent(root.name)}@${encodeURIComponent(root.version)}`;
const dependencies = [{ ref: rootRef, dependsOn: dependencyRefs(root.dependencies, refs) }];
for (const [location, ref] of refs) dependencies.push({ ref, dependsOn: dependencyRefs(lock.packages[location]?.dependencies, refs) });
dependencies.sort((a, b) => a.ref.localeCompare(b.ref));
const fingerprint = createHash("sha256").update(JSON.stringify({ rootRef, components: components.map((item) => item["bom-ref"]) })).digest("hex");
const uuid = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-a${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
const bom = {
  bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: `urn:uuid:${uuid}`, version: 1,
  metadata: { timestamp: new Date().toISOString(), tools: { components: [{ type: "application", name: "dry-run-sbom-generator", version: "1" }] }, component: { type: "application", "bom-ref": rootRef, name: root.name, version: root.version, purl: rootRef } },
  components, dependencies,
};
await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, { flag: "w", mode: 0o600 });
console.log(JSON.stringify({ output, components: components.length, serialNumber: bom.serialNumber }));

function value(name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function dependencyRefs(values, known) { return Object.keys(values ?? {}).flatMap((name) => known.get(`node_modules/${name}`) ? [known.get(`node_modules/${name}`)] : []).sort(); }
function integrityHashes(integrity) {
  if (typeof integrity !== "string") return [];
  return integrity.split(/\s+/).flatMap((part) => {
    const match = /^(sha256|sha384|sha512)-(.+)$/.exec(part);
    if (!match) return [];
    try { return [{ alg: match[1].toUpperCase().replace("SHA", "SHA-"), content: Buffer.from(match[2], "base64").toString("hex").toUpperCase() }]; }
    catch { return []; }
  });
}
