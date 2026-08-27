import {
  constants,
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
} from "node:crypto";
import { TeamWorkspace, type IssuedTeamKey, type TeamMember, type TeamRole } from "./team.ts";

export interface OidcRoleMapping {
  group: string;
  role: Exclude<TeamRole, "ingest">;
  projectIds?: string[];
}

export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  cookieSecret: string;
  scopes?: string[];
  defaultRole?: Exclude<TeamRole, "ingest">;
  defaultProjectIds?: string[];
  groupsClaim?: string;
  roleMappings?: OidcRoleMapping[];
  allowedEmailDomains?: string[];
  requireVerifiedEmail?: boolean;
  sessionDays?: number;
  secureCookies?: boolean;
  allowInsecureIssuer?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface OidcLoginResult {
  location: string;
  transactionCookie: string;
}

export interface OidcCallbackResult {
  member: TeamMember;
  session: IssuedTeamKey;
  sessionCookie: string;
  clearTransactionCookie: string;
  returnTo: string;
}

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface OidcTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [key: string]: unknown;
}

export class OidcService {
  readonly workspace: TeamWorkspace;
  readonly options: OidcOptions;
  private readonly request: typeof fetch;
  private discoveryCache?: { value: OidcDiscovery; expiresAt: number };
  private jwksCache?: { value: JsonWebKey[]; expiresAt: number };

  constructor(workspace: TeamWorkspace, options: OidcOptions) {
    this.workspace = workspace;
    this.options = validateOidcOptions(options);
    this.request = options.fetch ?? fetch;
  }

  async begin(returnTo = "/"): Promise<OidcLoginResult> {
    const discovery = await this.discovery();
    const transaction: OidcTransaction = {
      state: randomBytes(24).toString("base64url"),
      nonce: randomBytes(24).toString("base64url"),
      verifier: randomBytes(48).toString("base64url"),
      returnTo: safeReturnTo(returnTo),
      expiresAt: Date.now() + 10 * 60_000,
    };
    const location = new URL(discovery.authorization_endpoint);
    location.searchParams.set("client_id", this.options.clientId);
    location.searchParams.set("redirect_uri", this.options.redirectUri);
    location.searchParams.set("response_type", "code");
    location.searchParams.set("scope", (this.options.scopes ?? ["openid", "profile", "email"]).join(" "));
    location.searchParams.set("state", transaction.state);
    location.searchParams.set("nonce", transaction.nonce);
    location.searchParams.set("code_challenge", createHash("sha256").update(transaction.verifier).digest("base64url"));
    location.searchParams.set("code_challenge_method", "S256");
    return { location: location.toString(), transactionCookie: this.cookie("dryrun_oidc_tx", signValue(transaction, this.options.cookieSecret), 600, true) };
  }

  async callback(params: { code?: string; state?: string; error?: string; errorDescription?: string }, cookieHeader?: string): Promise<OidcCallbackResult> {
    if (params.error) throw new OidcError(`Identity provider rejected login: ${params.error}${params.errorDescription ? ` (${params.errorDescription})` : ""}`, 401);
    if (!params.code || !params.state) throw new OidcError("OIDC callback requires code and state", 400);
    const signed = parseCookies(cookieHeader).dryrun_oidc_tx;
    const transaction = signed ? verifySignedValue<OidcTransaction>(signed, this.options.cookieSecret) : undefined;
    if (!transaction || transaction.expiresAt <= Date.now() || !safeEqual(transaction.state, params.state)) throw new OidcError("OIDC transaction is invalid or expired", 401);
    const discovery = await this.discovery();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: this.options.redirectUri,
      client_id: this.options.clientId,
      code_verifier: transaction.verifier,
    });
    if (this.options.clientSecret) form.set("client_secret", this.options.clientSecret);
    const response = await this.request(discovery.token_endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    });
    if (!response.ok) throw new OidcError(`OIDC token exchange failed with HTTP ${response.status}`, 502);
    const tokenBody = await response.json() as Record<string, unknown>;
    if (typeof tokenBody.id_token !== "string") throw new OidcError("OIDC token response has no id_token", 502);
    const claims = await this.verifyIdToken(tokenBody.id_token, discovery, transaction.nonce);
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email) throw new OidcError("OIDC id_token has no email claim", 403);
    if ((this.options.requireVerifiedEmail ?? true) && claims.email_verified !== true) throw new OidcError("OIDC email is not verified", 403);
    const domain = email.split("@")[1] ?? "";
    if (this.options.allowedEmailDomains?.length && !this.options.allowedEmailDomains.includes(domain)) throw new OidcError("OIDC email domain is not allowed", 403);
    const access = this.resolveAccess(claims);
    const member = await this.workspace.provisionFederatedMember({
      provider: "oidc",
      issuer: claims.iss,
      subject: claims.sub,
      email,
      name: typeof claims.name === "string" && claims.name.trim() ? claims.name : typeof claims.preferred_username === "string" ? claims.preferred_username : email,
      role: access.role,
      ...(access.projectIds ? { projectIds: access.projectIds } : {}),
    });
    const session = await this.workspace.createMemberSession(member.id, `oidc:${claims.iss}`, this.options.sessionDays ?? 1);
    return {
      member,
      session,
      sessionCookie: this.cookie("dryrun_session", session.token, (this.options.sessionDays ?? 1) * 86_400, true),
      clearTransactionCookie: this.cookie("dryrun_oidc_tx", "", 0, true),
      returnTo: transaction.returnTo,
    };
  }

  clearSessionCookie(): string { return this.cookie("dryrun_session", "", 0, true); }

  private async discovery(): Promise<OidcDiscovery> {
    if (this.discoveryCache && this.discoveryCache.expiresAt > Date.now()) return this.discoveryCache.value;
    const url = new URL(`${this.options.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    this.assertRemoteUrl(url);
    const response = await this.request(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000) });
    if (!response.ok) throw new OidcError(`OIDC discovery failed with HTTP ${response.status}`, 502);
    const value = await response.json() as Record<string, unknown>;
    if (value.issuer !== this.options.issuer || typeof value.authorization_endpoint !== "string" || typeof value.token_endpoint !== "string" || typeof value.jwks_uri !== "string") throw new OidcError("OIDC discovery document is invalid", 502);
    const discovery = value as unknown as OidcDiscovery;
    for (const endpoint of [discovery.authorization_endpoint, discovery.token_endpoint, discovery.jwks_uri]) this.assertRemoteUrl(new URL(endpoint));
    this.discoveryCache = { value: discovery, expiresAt: Date.now() + 5 * 60_000 };
    return discovery;
  }

  private async verifyIdToken(token: string, discovery: OidcDiscovery, nonce: string): Promise<IdTokenClaims> {
    if (token.length > 64 * 1024) throw new OidcError("OIDC id_token is too large", 401);
    const parts = token.split(".");
    if (parts.length !== 3) throw new OidcError("OIDC id_token is malformed", 401);
    const header = decodeJson(parts[0], "OIDC JWT header") as Record<string, unknown>;
    const claims = decodeJson(parts[1], "OIDC JWT claims") as IdTokenClaims;
    if (!header.kid || typeof header.kid !== "string" || !["RS256", "PS256", "ES256"].includes(String(header.alg))) throw new OidcError("OIDC JWT algorithm or key id is unsupported", 401);
    const keys = await this.jwks(discovery.jwks_uri);
    const jwk = keys.find((candidate) => candidate.kid === header.kid && (!candidate.use || candidate.use === "sig") && (!candidate.alg || candidate.alg === header.alg));
    if (!jwk) throw new OidcError("OIDC signing key was not found", 401);
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], "base64url");
    let valid = false;
    if (header.alg === "RS256") valid = verifySignature("sha256", data, key, signature);
    else if (header.alg === "PS256") valid = verifySignature("sha256", data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
    else valid = verifySignature("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
    if (!valid) throw new OidcError("OIDC id_token signature is invalid", 401);
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== this.options.issuer || typeof claims.sub !== "string" || !claims.sub || typeof claims.exp !== "number" || claims.exp < now - 60) throw new OidcError("OIDC id_token issuer, subject, or expiry is invalid", 401);
    if (claims.iat != null && (typeof claims.iat !== "number" || claims.iat > now + 60)) throw new OidcError("OIDC id_token issued-at time is invalid", 401);
    if (claims.nbf != null && (typeof claims.nbf !== "number" || claims.nbf > now + 60)) throw new OidcError("OIDC id_token not-before time is invalid", 401);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.options.clientId) || audiences.length > 1 && claims.azp !== this.options.clientId) throw new OidcError("OIDC id_token audience is invalid", 401);
    if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, nonce)) throw new OidcError("OIDC id_token nonce is invalid", 401);
    return claims;
  }

  private async jwks(uri: string): Promise<JsonWebKey[]> {
    if (this.jwksCache && this.jwksCache.expiresAt > Date.now()) return this.jwksCache.value;
    const url = new URL(uri);
    this.assertRemoteUrl(url);
    const response = await this.request(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000) });
    if (!response.ok) throw new OidcError(`OIDC JWKS request failed with HTTP ${response.status}`, 502);
    const body = await response.json() as Record<string, unknown>;
    if (!Array.isArray(body.keys) || body.keys.length > 100) throw new OidcError("OIDC JWKS document is invalid", 502);
    const keys = body.keys.filter((value): value is JsonWebKey => typeof value === "object" && value !== null);
    this.jwksCache = { value: keys, expiresAt: Date.now() + 5 * 60_000 };
    return keys;
  }

  private resolveAccess(claims: IdTokenClaims): { role: Exclude<TeamRole, "ingest">; projectIds?: string[] } {
    const claim = getNestedClaim(claims, this.options.groupsClaim ?? "groups");
    const groups = new Set(Array.isArray(claim) ? claim.filter((value): value is string => typeof value === "string") : []);
    const matches = (this.options.roleMappings ?? []).filter((mapping) => groups.has(mapping.group));
    if (!matches.length) return { role: this.options.defaultRole ?? "viewer", ...(this.options.defaultProjectIds ? { projectIds: [...this.options.defaultProjectIds] } : {}) };
    const rank: Record<Exclude<TeamRole, "ingest">, number> = { viewer: 1, editor: 2, admin: 3 };
    const role = matches.map((mapping) => mapping.role).sort((a, b) => rank[b] - rank[a])[0];
    const unscoped = matches.some((mapping) => mapping.projectIds == null);
    return { role, ...(!unscoped ? { projectIds: [...new Set(matches.flatMap((mapping) => mapping.projectIds ?? []))] } : {}) };
  }

  private cookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
    return `${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${this.options.secureCookies === false ? "" : "; Secure"}`;
  }

  private assertRemoteUrl(url: URL): void {
    if (url.username || url.password || url.hash) throw new Error("OIDC endpoints cannot contain credentials or fragments");
    if (url.protocol !== "https:" && !this.options.allowInsecureIssuer) throw new Error("OIDC endpoints require HTTPS");
    if (!/^https?:$/.test(url.protocol)) throw new Error("OIDC endpoints must use HTTP(S)");
  }
}

export class OidcError extends Error {
  readonly status: 400 | 401 | 403 | 502;
  constructor(message: string, status: 400 | 401 | 403 | 502) { super(message); this.name = "OidcError"; this.status = status; }
}

function validateOidcOptions(options: OidcOptions): OidcOptions {
  const issuer = new URL(options.issuer);
  const redirect = new URL(options.redirectUri);
  if (!options.clientId.trim() || options.clientId.length > 512) throw new Error("OIDC clientId is required");
  if (Buffer.byteLength(options.cookieSecret) < 32) throw new Error("OIDC cookieSecret must contain at least 32 bytes");
  if (issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error("OIDC issuer cannot contain credentials, query, or fragment");
  if (redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error("OIDC redirectUri cannot contain credentials, query, or fragment");
  if (issuer.protocol !== "https:" && !options.allowInsecureIssuer) throw new Error("OIDC issuer requires HTTPS");
  if (redirect.protocol !== "https:" && !options.allowInsecureIssuer) throw new Error("OIDC redirectUri requires HTTPS");
  if (options.allowedEmailDomains?.some((value) => !/^[a-z0-9.-]+$/i.test(value))) throw new Error("OIDC allowed email domains are invalid");
  if (options.scopes && (!options.scopes.includes("openid") || options.scopes.some((value) => !value.trim()))) throw new Error("OIDC scopes must contain openid and non-empty values");
  if (options.sessionDays != null && (!Number.isInteger(options.sessionDays) || options.sessionDays < 1 || options.sessionDays > 365)) throw new Error("OIDC sessionDays must be between 1 and 365");
  if (options.timeoutMs != null && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 60_000)) throw new Error("OIDC timeoutMs must be between 100 and 60000");
  for (const mapping of options.roleMappings ?? []) {
    if (!mapping.group?.trim() || !["admin", "editor", "viewer"].includes(mapping.role) || mapping.projectIds?.some((value) => !value.trim())) throw new Error("OIDC role mappings are invalid");
  }
  return { ...options, issuer: issuer.toString().replace(/\/$/, ""), redirectUri: redirect.toString() };
}

function signValue(value: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySignedValue<T>(value: string, secret: string): T | undefined {
  if (value.length > 16 * 1024) return undefined;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) return undefined;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(signature, expected)) return undefined;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T; } catch { return undefined; }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeJson(value: string, label: string): unknown {
  try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch { throw new OidcError(`${label} is invalid`, 401); }
}

function parseCookies(value?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of value?.split(";") ?? []) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}

function safeReturnTo(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.length > 2048) return "/";
  return value;
}

function getNestedClaim(claims: IdTokenClaims, path: string): unknown {
  let value: unknown = claims;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

export function sessionTokenFromCookies(header?: string): string | undefined {
  return parseCookies(header).dryrun_session;
}
