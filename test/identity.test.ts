import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OidcService } from "../src/identity.ts";
import { startTeamServer } from "../src/team-server.ts";
import { TeamWorkspace } from "../src/team.ts";

const dirs: string[] = [];
const handles: Array<{ close(): Promise<void> }> = [];
function tempDir(): string { const dir = mkdtempSync(path.join(tmpdir(), "dryrun-identity-")); dirs.push(dir); return dir; }
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("free federated identity", () => {
  it("performs OIDC authorization-code + PKCE with signed state and verified ID tokens", async () => {
    const { workspace } = await TeamWorkspace.initialize(tempDir(), "OIDC team");
    const project = workspace.project("default").project;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    Object.assign(jwk, { kid: "test-key", use: "sig", alg: "RS256" });
    let nonce = "";
    let exchangedBody = "";
    const request: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: "https://id.example", authorization_endpoint: "https://id.example/authorize", token_endpoint: "https://id.example/token", jwks_uri: "https://id.example/jwks" });
      if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
      if (url.endsWith("/token")) {
        exchangedBody = String(init?.body);
        const now = Math.floor(Date.now() / 1000);
        return Response.json({ id_token: jwt({ iss: "https://id.example", sub: "user-123", aud: "dry-run", exp: now + 300, iat: now, nonce, email: "Ada@Example.com", email_verified: true, name: "Ada", groups: ["quality-admins"] }, privateKey) });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const service = new OidcService(workspace, {
      issuer: "https://id.example",
      clientId: "dry-run",
      redirectUri: "https://quality.example/api/v1/auth/oidc/callback",
      cookieSecret: "0123456789abcdef0123456789abcdef",
      groupsClaim: "groups",
      roleMappings: [{ group: "quality-admins", role: "admin", projectIds: [project.id] }],
      fetch: request,
    });
    const login = await service.begin("/dashboard");
    const authorization = new URL(login.location);
    nonce = authorization.searchParams.get("nonce")!;
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(login.transactionCookie).toContain("HttpOnly");
    await expect(service.callback({ code: "authorization-code", state: "tampered-state" }, login.transactionCookie)).rejects.toThrow("invalid or expired");
    const result = await service.callback({ code: "authorization-code", state: authorization.searchParams.get("state")! }, login.transactionCookie);
    expect(exchangedBody).toContain("code_verifier=");
    expect(result.member).toMatchObject({ email: "ada@example.com", role: "admin", projectIds: [project.id], status: "active" });
    expect(workspace.authenticate(result.session.token)).toMatchObject({ memberId: result.member.id, memberName: "Ada", role: "admin" });
    expect(result.sessionCookie).toContain("Secure");
    expect(result.returnTo).toBe("/dashboard");

    const nonceLogin = await service.begin("//attacker.example");
    const nonceAuthorization = new URL(nonceLogin.location);
    nonce = "wrong-nonce";
    await expect(service.callback({ code: "authorization-code", state: nonceAuthorization.searchParams.get("state")! }, nonceLogin.transactionCookie)).rejects.toThrow("nonce is invalid");
  });

  it("implements authenticated SCIM user create, filter, patch, and deprovision", async () => {
    const { workspace } = await TeamWorkspace.initialize(tempDir(), "SCIM team");
    const scimToken = "scim_abcdefghijklmnopqrstuvwxyz_0123456789";
    const handle = await startTeamServer({ workspace, port: 0, scim: { token: scimToken, defaultRole: "editor" } });
    handles.push(handle);
    const endpoint = `${handle.url}/scim/v2/Users`;
    expect((await fetch(endpoint)).status).toBe(401);
    const headers = { Authorization: `Bearer ${scimToken}`, "Content-Type": "application/scim+json" };
    const createdResponse = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], externalId: "directory-7", userName: "reviewer@example.com", displayName: "SCIM Reviewer", active: true }) });
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("content-type")).toContain("application/scim+json");
    const created = await createdResponse.json() as any;
    expect(created).toMatchObject({ userName: "reviewer@example.com", active: true, roles: [{ value: "editor", primary: true }] });
    const filtered = await (await fetch(`${endpoint}?filter=${encodeURIComponent('externalId eq "directory-7"')}`, { headers })).json() as any;
    expect(filtered.totalResults).toBe(1);

    const patched = await fetch(`${endpoint}/${created.id}`, { method: "PATCH", headers, body: JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] }) });
    expect(patched.status).toBe(200);
    expect((await patched.json() as any).active).toBe(false);
    expect(workspace.config().members?.[0].status).toBe("suspended");
    expect((await fetch(`${endpoint}/${created.id}`, { method: "DELETE", headers })).status).toBe(204);
  });
});

function jwt(claims: Record<string, unknown>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}
