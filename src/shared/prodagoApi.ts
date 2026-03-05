/**
 * Shared Prodago API client for MCP tool handlers.
 * 
 * Token acquisition strategy (user pass-through):
 * 1. The Foundry Agent forwards the user's Entra ID token to the MCP server
 * 2. The MCP handler extracts it from triggerMetadata / request headers
 * 3. We call saas.prodago.com with the user's Entra token
 * 4. saas.prodago.com returns:
 *    - Authorization header → the Prodago bearer token
 *    - preferred-tenant header → the tenant context for API calls
 * 5. We cache BOTH and use them for all Prodago API calls
 * 
 * Fallback: if PRODAGO_API_TOKEN is set, use it directly (dev/testing).
 */

const API_URL = process.env.PRODAGO_API_URL || "https://prodago-api-prod2.azurewebsites.net/api";
const SAAS_URL = process.env.PRODAGO_SAAS_URL || "https://saas.prodago.com/";
const STATIC_TOKEN = process.env.PRODAGO_API_TOKEN;

// ── Per-user credentials cache ───────────────────────────────
// Maps user Entra token hash → { prodagoToken, preferredTenant, expiry }
interface CachedCredentials {
    token: string;
    preferredTenant: string | null;
    expiry: number;
}
const credentialsCache = new Map<string, CachedCredentials>();
const TOKEN_CACHE_DURATION_MS = 50 * 60 * 1000; // 50 minutes


/**
 * Simple hash for cache key (avoids storing full Entra tokens as keys)
 */
function hashToken(token: string): string {
    // Use last 32 chars of the token as a simple cache key
    return token.slice(-32);
}

/**
 * Exchanges a user's Entra ID token for Prodago API credentials.
 *
 * The call to saas.prodago.com returns THREE things:
 *   1. Authorization response header → Prodago bearer token
 *   2. preferred-tenant response header → default tenant name
 *   3. Response body → list of available tenants (userTenants)
 *
 * We do two fetches:
 *   - redirect: "manual" → captures Authorization from the 302 response
 *   - redirect: "follow" → captures preferred-tenant header + body from final response
 */
async function exchangeForProdagoCredentials(userEntraToken: string): Promise<CachedCredentials> {
    const cacheKey = hashToken(userEntraToken);

    // Check cache first
    const cached = credentialsCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
        return cached;
    }

    console.log("[TokenManager] Exchanging user Entra token via", SAAS_URL);

    // ── Fetch 1: redirect=manual → get Authorization header from 302 ──
    const redirectRes = await fetch(SAAS_URL, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${userEntraToken}`,
            "Accept": "application/json",
        },
        redirect: "manual",
    });

    console.log(`[TokenManager] Fetch1 (manual) status: ${redirectRes.status}`);

    const authHeader = redirectRes.headers.get("Authorization");

    // Also try to get preferred-tenant from the 302 (might be here or on final)
    let preferredTenant: string | null = redirectRes.headers.get("preferred-tenant");
    if (preferredTenant) {
        console.log(`[TokenManager] Got preferred-tenant from 302: ${preferredTenant}`);
    }

    // ── Fetch 2: redirect=follow → get preferred-tenant header + body ──
    console.log("[TokenManager] Fetch2 (follow redirect) to get tenant + body...");
    const followRes = await fetch(SAAS_URL, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${userEntraToken}`,
            "Accept": "application/json",
        },
        // Default: follow redirects
    });

    console.log(`[TokenManager] Fetch2 (follow) status: ${followRes.status}`);

    // Log ALL headers from the followed response
    const followHeaders: Record<string, string> = {};
    followRes.headers.forEach((value, key) => {
        followHeaders[key] = key.toLowerCase().includes('auth')
            ? `${value.substring(0, 30)}...(len:${value.length})`
            : value;
    });
    console.log(`[TokenManager] Fetch2 headers: ${JSON.stringify(followHeaders)}`);

    // Get preferred-tenant from followed response if not already found
    if (!preferredTenant) {
        preferredTenant = followRes.headers.get("preferred-tenant");
        if (preferredTenant) {
            console.log(`[TokenManager] Got preferred-tenant from followed response: ${preferredTenant}`);
        }
    }

    // Get Authorization from followed response if not from 302
    const followAuthHeader = followRes.headers.get("Authorization");
    const effectiveAuthHeader = authHeader || followAuthHeader;

    if (!effectiveAuthHeader) {
        const bodyText = await followRes.text().catch(() => '');
        console.error("[TokenManager] No Authorization header from either fetch. Body:", bodyText.substring(0, 300));
        throw new Error(
            `saas.prodago.com did not return an Authorization header.`
        );
    }

    const prodagoToken = effectiveAuthHeader.startsWith("Bearer ")
        ? effectiveAuthHeader.substring(7)
        : effectiveAuthHeader;
    console.log(`[TokenManager] ✅ Got Prodago token (length: ${prodagoToken.length})`);

    // Parse body for userTenants list
    const bodyText = await followRes.text();
    console.log(`[TokenManager] Fetch2 body (first 500): ${bodyText.substring(0, 500)}`);

    let availableTenants: any[] = [];
    if (bodyText) {
        try {
            const bodyData = JSON.parse(bodyText);

            // Extract tenants array from body
            if (Array.isArray(bodyData)) {
                availableTenants = bodyData;
            } else if (bodyData?.tenants && Array.isArray(bodyData.tenants)) {
                availableTenants = bodyData.tenants;
            } else if (bodyData?.userTenants && Array.isArray(bodyData.userTenants)) {
                availableTenants = bodyData.userTenants;
            } else if (bodyData?.data && Array.isArray(bodyData.data)) {
                availableTenants = bodyData.data;
            }

            console.log(`[TokenManager] Found ${availableTenants.length} tenants in body`);
            if (availableTenants.length > 0) {
                console.log(`[TokenManager] Tenants: ${availableTenants.map((t: any) => t.tenantName || t.name || t.id).join(', ')}`);
            }

            // If we still don't have a preferred-tenant, use the first one from the list
            if (!preferredTenant && availableTenants.length > 0) {
                preferredTenant = availableTenants[0].tenantName || availableTenants[0].name
                    || availableTenants[0].tenantId || availableTenants[0].id;
                console.log(`[TokenManager] Using first tenant as default: ${preferredTenant}`);
            }
        } catch {
            console.warn("[TokenManager] Body is not valid JSON:", bodyText.substring(0, 200));
        }
    }

    if (preferredTenant) {
        console.log(`[TokenManager] ✅ preferred-tenant: ${preferredTenant}`);
    } else {
        console.error(`[TokenManager] ❌ NO preferred-tenant found!`);
    }

    // Cache token + tenant
    const credentials: CachedCredentials = {
        token: prodagoToken,
        preferredTenant,
        expiry: Date.now() + TOKEN_CACHE_DURATION_MS,
    };
    credentialsCache.set(cacheKey, credentials);

    return credentials;
}



/**
 * Extracts the user's Entra token from the MCP trigger context.
 * 
 * The MCP extension provides the ToolInvocationContext which contains a
 * 'transport' object with HTTP headers (including the Authorization header).
 * We check multiple locations for maximum compatibility:
 *   1. toolInvocationContext.transport.headers (MCP extension path)
 *   2. triggerMetadata flat fields
 *   3. triggerMetadata.headers object
 */
export function extractUserToken(triggerMetadata: Record<string, any>, toolInvocationContext?: any): string | null {
    const authFields = [
        'authorization', 'Authorization',
        'x-ms-token-aad-access-token', 'X-MS-TOKEN-AAD-ACCESS-TOKEN',
        'bearer_token', 'access_token',
    ];

    const extractBearer = (value: string): string => {
        return value.startsWith('Bearer ') ? value.substring(7) : value;
    };

    // 1. Check toolInvocationContext.transport.headers (MCP extension path)
    if (toolInvocationContext) {
        const transport = toolInvocationContext?.transport;
        if (transport?.headers && typeof transport.headers === 'object') {
            for (const field of authFields) {
                const value = transport.headers[field];
                if (value && typeof value === 'string') {
                    console.log(`[TokenManager] Found token in toolInvocationContext.transport.headers.${field}`);
                    return extractBearer(value);
                }
            }
            // Case-insensitive scan of transport headers
            for (const [key, val] of Object.entries(transport.headers)) {
                if (typeof val === 'string' && key.toLowerCase() === 'authorization') {
                    console.log(`[TokenManager] Found token in transport.headers['${key}'] (scan)`);
                    return extractBearer(val);
                }
            }
        }
    }

    // 2. Check triggerMetadata (various possible locations)
    if (triggerMetadata) {
        // 2a. Check transport.headers inside triggerMetadata (serialized from ToolInvocationContext)
        const transport = triggerMetadata.transport;
        if (transport?.headers && typeof transport.headers === 'object') {
            for (const field of authFields) {
                const value = transport.headers[field];
                if (value && typeof value === 'string') {
                    console.log(`[TokenManager] Found token in triggerMetadata.transport.headers.${field}`);
                    return extractBearer(value);
                }
            }
        }

        // 2b. Check flat triggerMetadata fields
        for (const field of authFields) {
            const value = triggerMetadata[field];
            if (value && typeof value === 'string') {
                console.log(`[TokenManager] Found token in triggerMetadata.${field}`);
                return extractBearer(value);
            }
        }

        // 2c. Check nested headers object
        if (triggerMetadata.headers && typeof triggerMetadata.headers === 'object') {
            for (const field of authFields) {
                const value = triggerMetadata.headers[field];
                if (value && typeof value === 'string') {
                    console.log(`[TokenManager] Found token in triggerMetadata.headers.${field}`);
                    return extractBearer(value);
                }
            }
        }
    }

    console.warn("[TokenManager] No Entra token found in any known location");
    return null;
}

/**
 * Diagnostic function: runs the full auth flow and returns detailed debug info.
 * Used by the debug_auth action to troubleshoot authentication issues.
 */
export async function debugAuth(userEntraToken: string | null): Promise<Record<string, any>> {
    const diag: Record<string, any> = {
        timestamp: new Date().toISOString(),
        apiUrl: API_URL,
        saasUrl: SAAS_URL,
        hasStaticToken: !!STATIC_TOKEN,
        userTokenFound: !!userEntraToken,
        userTokenLength: userEntraToken?.length ?? 0,
    };

    if (!userEntraToken) {
        diag.error = "No user Entra token found in request";
        return diag;
    }

    // Step 1: Call saas.prodago.com
    try {
        const saasResponse = await fetch(SAAS_URL, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${userEntraToken}`,
                "Accept": "application/json",
            },
            redirect: "manual",
        });

        diag.saasStatus = saasResponse.status;
        diag.saasStatusText = saasResponse.statusText;

        // Dump all response headers
        const saasHeaders: Record<string, string> = {};
        saasResponse.headers.forEach((value, key) => {
            saasHeaders[key] = key.toLowerCase().includes('auth') ? `${value.substring(0, 20)}...` : value;
        });
        diag.saasResponseHeaders = saasHeaders;

        const authHeader = saasResponse.headers.get("Authorization");
        diag.saasHasAuthHeader = !!authHeader;

        const saasPreferredTenant = saasResponse.headers.get("preferred-tenant");
        diag.saasPreferredTenant = saasPreferredTenant || "NONE";

        if (!authHeader) {
            diag.error = "saas.prodago.com did not return Authorization header";
            const bodyText = await saasResponse.text().catch(() => '');
            diag.saasBody = bodyText.substring(0, 500);
            return diag;
        }

        const prodagoToken = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
        diag.prodagoTokenLength = prodagoToken.length;

        // Step 2: Call /api/User/userTenants
        try {
            const tenantHeaders: Record<string, string> = {
                "Authorization": `Bearer ${prodagoToken}`,
                "Accept": "application/json",
            };
            if (saasPreferredTenant) {
                tenantHeaders["preferred-tenant"] = saasPreferredTenant;
            }

            const tenantsResponse = await fetch(`${API_URL}/User/userTenants`, {
                method: "GET",
                headers: tenantHeaders,
            });

            diag.userTenantsStatus = tenantsResponse.status;
            diag.userTenantsStatusText = tenantsResponse.statusText;

            if (tenantsResponse.ok) {
                const tenantsData = await tenantsResponse.json() as any;
                diag.userTenantsRawResponse = JSON.stringify(tenantsData).substring(0, 1000);
                const tenants = Array.isArray(tenantsData) ? tenantsData : tenantsData?.tenants;
                diag.tenantsCount = tenants?.length ?? 0;
                if (tenants && tenants.length > 0) {
                    diag.tenantsList = tenants.map((t: any) => ({
                        tenantId: t.tenantId || t.id || t.TenantId,
                        name: t.name || t.tenantName || t.TenantName,
                        ...t,
                    }));
                    diag.resolvedTenant = tenants[0].tenantId || tenants[0].id || tenants[0].TenantId;
                }
            } else {
                const errorBody = await tenantsResponse.text().catch(() => '');
                diag.userTenantsError = errorBody.substring(0, 500);
            }
        } catch (err: any) {
            diag.userTenantsException = err.message;
        }

        // Step 3: Try calling /projects with the resolved tenant
        const effectiveTenant = diag.resolvedTenant || saasPreferredTenant;
        diag.effectiveTenant = effectiveTenant || "NONE";

        try {
            const projectHeaders: Record<string, string> = {
                "Authorization": `Bearer ${prodagoToken}`,
                "Accept": "application/json",
                "Accept-Language": "en",
            };
            if (effectiveTenant) {
                projectHeaders["preferred-tenant"] = effectiveTenant;
            }

            const projectsResponse = await fetch(`${API_URL}/projects`, {
                method: "GET",
                headers: projectHeaders,
            });

            diag.projectsStatus = projectsResponse.status;
            diag.projectsStatusText = projectsResponse.statusText;

            if (projectsResponse.ok) {
                const projectsData = await projectsResponse.json() as any;
                const projects = Array.isArray(projectsData) ? projectsData : [];
                diag.projectsCount = projects.length;
                if (projects.length > 0) {
                    diag.firstProject = { id: projects[0].id, name: projects[0].name };
                }
            } else {
                const errorBody = await projectsResponse.text().catch(() => '');
                diag.projectsError = errorBody.substring(0, 500);
            }
        } catch (err: any) {
            diag.projectsException = err.message;
        }

    } catch (err: any) {
        diag.saasException = err.message;
    }

    return diag;
}

/**
 * Options for fetchProdagoAPI beyond GET requests.
 */
export interface FetchOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
}

/**
 * Fetches data from the Prodago API.
 * If a user Entra token is provided, exchanges it for Prodago credentials via saas.prodago.com.
 * The preferred-tenant header from saas is forwarded to all API calls.
 * Otherwise falls back to the static PRODAGO_API_TOKEN.
 *
 * Supports all HTTP methods (GET, POST, PUT, DELETE) via the options parameter.
 */
export async function fetchProdagoAPI<T>(
    endpoint: string,
    userEntraToken?: string | null,
    options?: FetchOptions,
): Promise<T> {
    let token: string;
    let preferredTenant: string | null = null;

    if (userEntraToken) {
        // Exchange user's Entra token for Prodago credentials (token + preferred-tenant)
        const credentials = await exchangeForProdagoCredentials(userEntraToken);
        token = credentials.token;
        preferredTenant = credentials.preferredTenant;
    } else if (STATIC_TOKEN) {
        // Fallback to static token (dev/testing)
        console.log("[TokenManager] Using static PRODAGO_API_TOKEN (no user token available)");
        token = STATIC_TOKEN;

        // Resolve preferred-tenant for static token usage
        preferredTenant = process.env.PRODAGO_DEFAULT_TENANT || null;
        if (preferredTenant) {
            console.log(`[TokenManager] Using PRODAGO_DEFAULT_TENANT: ${preferredTenant}`);
        } else {
            // Try saas.prodago.com with static token to get tenant
            try {
                const saasRes = await fetch(SAAS_URL, {
                    method: "GET",
                    headers: { "Authorization": `Bearer ${STATIC_TOKEN}`, "Accept": "application/json" },
                    redirect: "manual",
                });
                preferredTenant = saasRes.headers.get("preferred-tenant");
                if (!preferredTenant) {
                    const followRes = await fetch(SAAS_URL, {
                        method: "GET",
                        headers: { "Authorization": `Bearer ${STATIC_TOKEN}`, "Accept": "application/json" },
                    });
                    preferredTenant = followRes.headers.get("preferred-tenant");
                    if (!preferredTenant) {
                        const body = await followRes.text().catch(() => '');
                        try {
                            const data = JSON.parse(body);
                            const tenants = Array.isArray(data) ? data : data?.tenants || data?.userTenants || [];
                            if (tenants.length > 0) {
                                preferredTenant = tenants[0].tenantName || tenants[0].name || tenants[0].tenantId || tenants[0].id;
                            }
                        } catch { /* not JSON */ }
                    }
                }
                if (preferredTenant) {
                    console.log(`[TokenManager] Got tenant from saas (static token): ${preferredTenant}`);
                } else {
                    console.warn("[TokenManager] Could not resolve tenant from saas with static token");
                }
            } catch (err: any) {
                console.warn(`[TokenManager] saas call with static token failed: ${err.message}`);
            }
        }
    } else {
        throw new Error(
            "No user token available and PRODAGO_API_TOKEN not configured. " +
            "The Foundry Agent must forward the user's Entra token to the MCP server."
        );
    }

    const method = options?.method || 'GET';
    const url = `${API_URL}${endpoint}`;
    const apiHeaders: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Accept-Language': 'en',
    };

    if (preferredTenant) {
        apiHeaders['preferred-tenant'] = preferredTenant;
    }

    // Add Content-Type for requests with a body
    if (options?.body !== undefined) {
        apiHeaders['Content-Type'] = 'application/json';
    }

    const fetchInit: RequestInit = {
        method,
        headers: apiHeaders,
    };

    if (options?.body !== undefined) {
        fetchInit.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchInit);

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        // If 401, invalidate cache for this token
        if (response.status === 401 && userEntraToken) {
            const cacheKey = hashToken(userEntraToken);
            credentialsCache.delete(cacheKey);
            console.warn(`[TokenManager] Got 401 — invalidated cache. Body: ${errorBody.substring(0, 300)}`);
        }
        console.error(`[API Error] ${method} ${endpoint} → ${response.status} | tenant: ${preferredTenant || 'NONE'} | body: ${errorBody.substring(0, 300)}`);
        throw new Error(`Prodago API error: ${response.status} ${response.statusText} for ${method} ${endpoint}. Tenant: ${preferredTenant || 'NONE'}`);
    }

    // Handle 204 No Content responses (common for PUT/DELETE)
    if (response.status === 204) {
        return null as T;
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) {
        return null as T;
    }

    return JSON.parse(text) as T;
}
