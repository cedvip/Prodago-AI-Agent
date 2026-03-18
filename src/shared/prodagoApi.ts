/**
 * Shared Prodago API client for MCP tool handlers.
 *
 * ── Token flow (fully transparent to the user) ─────────────────────────────
 * 1. Azure Foundry agent connects with a user Entra ID account.
 * 2. On every MCP tool call, Foundry forwards the user's Entra Bearer token
 *    via the HTTP Authorization header of the MCP transport.
 * 3. extractUserToken() pulls it from triggerMetadata / transport headers.
 * 4. getProdagoCredentials() calls https://saas.prodago.com/user with that
 *    Entra token and receives:
 *      - Authorization response header → Prodago bearer token
 *      - preferred-tenant response header → default tenant for this user
 * 5. Both are cached for 50 min (per Entra-token fingerprint).
 * 6. switchTenant() lets the user override the cached preferred-tenant for
 *    their session without re-exchanging the full token.
 * 7. fetchProdagoAPI() attaches the Prodago token + preferred-tenant to every
 *    downstream API call automatically.
 *
 * Fallback: if PRODAGO_API_TOKEN env var is set it is used directly (dev/CI).
 */

const API_URL  = process.env.PRODAGO_API_URL  || "https://prodago-api-prod2.azurewebsites.net/api";
const SAAS_URL = process.env.PRODAGO_SAAS_URL || "https://saas.prodago.com/user";
const STATIC_TOKEN = process.env.PRODAGO_API_TOKEN;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FetchOptions {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
}

interface CachedCredentials {
    /** Prodago bearer token returned by saas.prodago.com */
    prodagoToken: string;
    /** Default tenant from saas.prodago.com — may be overridden by switchTenant() */
    preferredTenant: string | null;
    /** ISO timestamp when the token expires (50 min from exchange) */
    expiry: number;
}

// ── In-process caches ─────────────────────────────────────────────────────────

/** Maps Entra-token fingerprint → Prodago credentials */
const credentialsCache = new Map<string, CachedCredentials>();

/**
 * Per-user tenant override.
 * Maps Entra-token fingerprint → tenant name chosen via set_preferred_tenant.
 * Cleared automatically if the credentials expire.
 */
const tenantOverride = new Map<string, string>();

const TOKEN_CACHE_MS = 50 * 60 * 1_000; // 50 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lightweight fingerprint for cache keys — avoids storing full JWT strings. */
function fingerprint(token: string): string {
    return token.slice(-40);
}

// ── Core: exchange Entra token → Prodago credentials ─────────────────────────

/**
 * Calls https://saas.prodago.com/user with the user's Entra Bearer token and
 * returns the Prodago token + preferred-tenant, using a 50-min in-process cache.
 *
 * saas.prodago.com returns:
 *   - Authorization header  → Prodago bearer token
 *   - preferred-tenant header → default tenant name
 *   - Body                  → list of user tenants (parsed as fallback)
 *
 * Two fetches are used:
 *   1. redirect: "manual"  → captures the Authorization from the 3xx Location
 *   2. redirect: "follow"  → follows to the final page to get preferred-tenant + body
 */
async function exchangeForProdagoCredentials(entraToken: string): Promise<CachedCredentials> {
    const key = fingerprint(entraToken);

    // Return cached credentials if still valid
    const cached = credentialsCache.get(key);
    if (cached && Date.now() < cached.expiry) {
        return cached;
    }

    console.log("[TokenManager] Exchanging Entra token via", SAAS_URL);

    const commonHeaders = {
        "Authorization": `Bearer ${entraToken}`,
        "Accept": "application/json",
    };

    // ── Fetch 1: manual redirect → grab Authorization from 3xx response ───────
    const manualRes = await fetch(SAAS_URL, {
        method: "GET",
        headers: commonHeaders,
        redirect: "manual",
    });
    console.log(`[TokenManager] Fetch1 (manual) status: ${manualRes.status}`);

    let authHeader = manualRes.headers.get("Authorization");
    let preferredTenant: string | null = manualRes.headers.get("preferred-tenant");

    // ── Fetch 2: follow redirect → grab preferred-tenant + body ──────────────
    const followRes = await fetch(SAAS_URL, {
        method: "GET",
        headers: commonHeaders,
        // default: follow redirects
    });
    console.log(`[TokenManager] Fetch2 (follow) status: ${followRes.status}`);

    if (!authHeader) {
        authHeader = followRes.headers.get("Authorization");
    }
    if (!preferredTenant) {
        preferredTenant = followRes.headers.get("preferred-tenant");
    }

    if (!authHeader) {
        const bodySnippet = await followRes.text().catch(() => "");
        throw new Error(
            `saas.prodago.com did not return an Authorization header. ` +
            `HTTP ${followRes.status}. Body: ${bodySnippet.substring(0, 300)}`
        );
    }

    // Strip "Bearer " prefix if present
    const prodagoToken = authHeader.startsWith("Bearer ")
        ? authHeader.substring(7)
        : authHeader;

    console.log(`[TokenManager] ✅ Prodago token obtained (length: ${prodagoToken.length})`);

    // Parse body as fallback source for preferred-tenant
    if (!preferredTenant) {
        const bodyText = await followRes.text().catch(() => "");
        try {
            const data = JSON.parse(bodyText);
            const tenants: any[] = Array.isArray(data)
                ? data
                : data?.tenants ?? data?.userTenants ?? data?.data ?? [];
            if (tenants.length > 0) {
                preferredTenant = tenants[0].tenantName ?? tenants[0].name
                    ?? tenants[0].tenantId ?? tenants[0].id ?? null;
                console.log(`[TokenManager] preferred-tenant resolved from body: ${preferredTenant}`);
            }
        } catch {
            /* body is not JSON, proceed without tenant */
        }
    }

    if (preferredTenant) {
        console.log(`[TokenManager] ✅ preferred-tenant: ${preferredTenant}`);
    } else {
        console.warn("[TokenManager] ❌ No preferred-tenant found — API calls may fail without it.");
    }

    const credentials: CachedCredentials = {
        prodagoToken,
        preferredTenant,
        expiry: Date.now() + TOKEN_CACHE_MS,
    };
    credentialsCache.set(key, credentials);

    // Clear any tenant override that belonged to the previous (now-expired) token
    tenantOverride.delete(key);

    return credentials;
}

// ── Public: tenant switching ──────────────────────────────────────────────────

/**
 * Overrides the in-flight preferred-tenant for the user identified by their
 * Entra token. The override is stored in memory for the lifetime of the
 * cached Prodago credentials (≈ 50 min).
 *
 * Returns the new effective tenant name.
 */
export function switchTenant(entraToken: string, tenantName: string): string {
    const key = fingerprint(entraToken);
    tenantOverride.set(key, tenantName);
    console.log(`[TokenManager] preferred-tenant switched to: ${tenantName}`);
    return tenantName;
}

/**
 * Returns the currently active preferred-tenant for the user.
 * Checks the in-memory override first, then the cached credentials.
 * Returns null if no Prodago credentials have been exchanged yet.
 */
export function getActiveTenant(entraToken: string): string | null {
    const key = fingerprint(entraToken);
    const override = tenantOverride.get(key);
    if (override) return override;
    return credentialsCache.get(key)?.preferredTenant ?? null;
}

// ── Public: token extraction from MCP context ─────────────────────────────────

/**
 * Extracts the user's Entra Bearer token from the MCP trigger context.
 *
 * Azure Foundry forwards the user's Entra ID token via the HTTP Authorization
 * header of the MCP WebHook request. The Azure Functions MCP host surfaces
 * this through multiple paths — we check all known paths for compatibility:
 *
 *   1. toolInvocationContext.transport.headers   (MCP SDK path)
 *   2. triggerMetadata.transport.headers         (serialized ToolInvocationContext)
 *   3. triggerMetadata.headers                   (flat headers object)
 *   4. triggerMetadata.*                         (top-level flat fields)
 */
export function extractUserToken(
    triggerMetadata: Record<string, any>,
    toolInvocationContext?: any
): string | null {
    const AUTH_FIELDS = [
        "authorization", "Authorization",
        "x-ms-token-aad-access-token", "X-MS-TOKEN-AAD-ACCESS-TOKEN",
        "bearer_token", "access_token",
    ];

    const stripBearer = (v: string) =>
        v.startsWith("Bearer ") ? v.substring(7) : v;

    const tryHeaders = (headers: Record<string, any>, source: string): string | null => {
        for (const field of AUTH_FIELDS) {
            const val = headers[field];
            if (val && typeof val === "string") {
                console.log(`[TokenManager] Entra token found in ${source}.${field}`);
                return stripBearer(val);
            }
        }
        // Case-insensitive fallback
        for (const [k, v] of Object.entries(headers)) {
            if (typeof v === "string" && k.toLowerCase() === "authorization") {
                console.log(`[TokenManager] Entra token found in ${source}['${k}'] (case-insensitive)`);
                return stripBearer(v);
            }
        }
        return null;
    };

    // 1. toolInvocationContext.transport.headers  (MCP SDK path)
    const ticTransport = toolInvocationContext?.transport;
    if (ticTransport?.headers && typeof ticTransport.headers === "object") {
        const t = tryHeaders(ticTransport.headers, "toolInvocationContext.transport.headers");
        if (t) return t;
    }

    // 2. triggerMetadata.transport.headers
    const mdTransport = triggerMetadata?.transport;
    if (mdTransport?.headers && typeof mdTransport.headers === "object") {
        const t = tryHeaders(mdTransport.headers, "triggerMetadata.transport.headers");
        if (t) return t;
    }

    // 3. triggerMetadata.headers
    if (triggerMetadata?.headers && typeof triggerMetadata.headers === "object") {
        const t = tryHeaders(triggerMetadata.headers, "triggerMetadata.headers");
        if (t) return t;
    }

    // 4. Top-level triggerMetadata fields
    if (triggerMetadata) {
        for (const field of AUTH_FIELDS) {
            const val = triggerMetadata[field];
            if (val && typeof val === "string") {
                console.log(`[TokenManager] Entra token found in triggerMetadata.${field}`);
                return stripBearer(val);
            }
        }
    }

    console.warn("[TokenManager] ⚠️  No Entra token found in any known location — ensure Foundry OAuth passthrough is configured.");
    return null;
}

// ── Public: main API fetch ────────────────────────────────────────────────────

/**
 * Performs an authenticated request to the Prodago API.
 *
 * Auth resolution (in order):
 *   1. User Entra token → exchanged for Prodago token + tenant via saas.prodago.com
 *   2. PRODAGO_API_TOKEN env var (static token for dev / CI)
 *
 * The preferred-tenant header is sent automatically on every request.
 * Users can switch tenant for their session via the set_preferred_tenant action
 * (which calls switchTenant() above).
 *
 * On 401, the cached credentials for that user are invalidated so the next call
 * will re-exchange the Entra token.
 */
export async function fetchProdagoAPI<T>(
    endpoint: string,
    entraToken?: string | null,
    options?: FetchOptions,
): Promise<T> {
    let prodagoToken: string;
    let preferredTenant: string | null = null;

    if (entraToken) {
        // ── Path 1: full OAuth passthrough (production) ───────────────────
        const creds = await exchangeForProdagoCredentials(entraToken);
        prodagoToken = creds.prodagoToken;

        // Check for tenant override (set via set_preferred_tenant action)
        const key = fingerprint(entraToken);
        preferredTenant = tenantOverride.get(key) ?? creds.preferredTenant;

    } else if (STATIC_TOKEN) {
        // ── Path 2: static token fallback (dev / CI) ─────────────────────
        console.log("[TokenManager] Using static PRODAGO_API_TOKEN");
        prodagoToken = STATIC_TOKEN;
        preferredTenant = process.env.PRODAGO_DEFAULT_TENANT || null;

        if (!preferredTenant) {
            // Try to resolve tenant from saas.prodago.com
            try {
                const r1 = await fetch(SAAS_URL, {
                    headers: { "Authorization": `Bearer ${STATIC_TOKEN}`, "Accept": "application/json" },
                    redirect: "manual",
                });
                preferredTenant = r1.headers.get("preferred-tenant");
                if (!preferredTenant) {
                    const r2 = await fetch(SAAS_URL, {
                        headers: { "Authorization": `Bearer ${STATIC_TOKEN}`, "Accept": "application/json" },
                    });
                    preferredTenant = r2.headers.get("preferred-tenant");
                    if (!preferredTenant) {
                        const body = await r2.text().catch(() => "");
                        try {
                            const data = JSON.parse(body);
                            const tenants: any[] = Array.isArray(data)
                                ? data
                                : data?.tenants ?? data?.userTenants ?? [];
                            preferredTenant = tenants[0]?.tenantName ?? tenants[0]?.name ?? null;
                        } catch { /* not JSON */ }
                    }
                }
                if (preferredTenant) {
                    console.log(`[TokenManager] Resolved tenant from saas (static token): ${preferredTenant}`);
                }
            } catch (err: any) {
                console.warn(`[TokenManager] saas call with static token failed: ${err.message}`);
            }
        }
    } else {
        throw new Error(
            "No authentication token available. The Azure Foundry Agent must be configured with " +
            "OAuth passthrough (project_connection_id) so the user's Entra token is forwarded to the MCP server."
        );
    }

    // ── Build request ─────────────────────────────────────────────────────
    const method = options?.method ?? "GET";
    const url    = `${API_URL}${endpoint}`;

    const headers: Record<string, string> = {
        "Authorization": `Bearer ${prodagoToken}`,
        "Accept":         "application/json",
        "Accept-Language": "en",
    };

    if (preferredTenant) {
        headers["preferred-tenant"] = preferredTenant;
    }

    if (options?.body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    console.log(`[API] ${method} ${endpoint} | tenant: ${preferredTenant ?? "NONE"}`);

    const response = await fetch(url, {
        method,
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    // ── Handle errors ─────────────────────────────────────────────────────
    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");

        if (response.status === 401 && entraToken) {
            // Invalidate cached credentials so the next call re-exchanges the token
            const key = fingerprint(entraToken);
            credentialsCache.delete(key);
            tenantOverride.delete(key);
            console.warn(`[TokenManager] 401 — credentials invalidated for re-exchange. Body: ${errorBody.substring(0, 300)}`);
        }

        console.error(`[API Error] ${method} ${endpoint} → ${response.status} | tenant: ${preferredTenant ?? "NONE"} | ${errorBody.substring(0, 300)}`);
        throw new Error(
            `Prodago API error ${response.status} ${response.statusText} on ${method} ${endpoint}. ` +
            `Tenant: ${preferredTenant ?? "NONE"}`
        );
    }

    // ── 204 No Content ────────────────────────────────────────────────────
    if (response.status === 204) return null as T;

    const text = await response.text();
    if (!text) return null as T;

    return JSON.parse(text) as T;
}

// ── Public: diagnostics ───────────────────────────────────────────────────────

/**
 * Runs the full auth exchange and returns a diagnostic snapshot.
 * Called by the debug_auth action. Never exposed directly to the end user.
 */
export async function debugAuth(entraToken: string | null): Promise<Record<string, any>> {
    const diag: Record<string, any> = {
        timestamp:      new Date().toISOString(),
        apiUrl:         API_URL,
        saasUrl:        SAAS_URL,
        hasStaticToken: !!STATIC_TOKEN,
        entraTokenFound: !!entraToken,
        entraTokenLength: entraToken?.length ?? 0,
    };

    if (!entraToken) {
        diag.error = "No Entra token found. Verify Foundry OAuth passthrough is configured (project_connection_id).";
        return diag;
    }

    try {
        // Step 1: saas.prodago.com (manual redirect)
        const saasRes = await fetch(SAAS_URL, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${entraToken}`,
                "Accept": "application/json",
            },
            redirect: "manual",
        });
        diag.saasStatus = saasRes.status;

        const saasHeaders: Record<string, string> = {};
        saasRes.headers.forEach((v, k) => {
            saasHeaders[k] = k.toLowerCase().includes("auth")
                ? `${v.substring(0, 20)}...(len:${v.length})`
                : v;
        });
        diag.saasResponseHeaders = saasHeaders;

        const authHeader = saasRes.headers.get("Authorization");
        diag.saasHasAuthHeader = !!authHeader;
        diag.saasPreferredTenant = saasRes.headers.get("preferred-tenant") ?? "NONE";

        if (!authHeader) {
            diag.error = "saas.prodago.com did not return an Authorization header";
            diag.saasBody = (await saasRes.text().catch(() => "")).substring(0, 500);
            return diag;
        }

        const prodagoToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
        diag.prodagoTokenLength = prodagoToken.length;

        // Step 2: /User/userTenants
        const tenantRes = await fetch(`${API_URL}/User/userTenants`, {
            headers: {
                "Authorization": `Bearer ${prodagoToken}`,
                "Accept": "application/json",
                ...(diag.saasPreferredTenant !== "NONE"
                    ? { "preferred-tenant": diag.saasPreferredTenant }
                    : {}),
            },
        });
        diag.userTenantsStatus = tenantRes.status;
        if (tenantRes.ok) {
            const data = await tenantRes.json() as any;
            const tenants: any[] = Array.isArray(data) ? data : data?.tenants ?? [];
            diag.tenantsCount = tenants.length;
            diag.tenantsList = tenants.map((t: any) => ({
                id: t.tenantId ?? t.id ?? t.TenantId,
                name: t.name ?? t.tenantName ?? t.TenantName,
            }));
        } else {
            diag.userTenantsError = (await tenantRes.text().catch(() => "")).substring(0, 500);
        }

        // Step 3: /projects quick smoke test
        const tenant = diag.saasPreferredTenant !== "NONE" ? diag.saasPreferredTenant : null;
        const projRes = await fetch(`${API_URL}/projects`, {
            headers: {
                "Authorization": `Bearer ${prodagoToken}`,
                "Accept": "application/json",
                "Accept-Language": "en",
                ...(tenant ? { "preferred-tenant": tenant } : {}),
            },
        });
        diag.projectsStatus = projRes.status;
        if (projRes.ok) {
            const projects = await projRes.json() as any[];
            diag.projectsCount = Array.isArray(projects) ? projects.length : 0;
        } else {
            diag.projectsError = (await projRes.text().catch(() => "")).substring(0, 300);
        }

    } catch (err: any) {
        diag.exception = err.message;
    }

    return diag;
}
