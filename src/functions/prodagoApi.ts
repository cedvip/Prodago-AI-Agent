import { app, InvocationContext, arg } from "@azure/functions";
import { fetchProdagoAPI, extractUserToken } from "../shared/prodagoApi";

/**
 * Single MCP tool that routes to all Prodago API endpoints via an `action` parameter.
 * Auth flow: Foundry Agent passes user Entra token → extracted from transport.headers
 * → exchanged with saas.prodago.com → Prodago bearer + preferred-tenant cached 50min
 */
app.mcpTool("prodago_api", {
    toolName: "prodago_api",
    description: `Call any Prodago governance API action. Use the 'action' parameter to specify what to do.

Available actions and their required parameters:

PROJECTS:
- get_projects — List all governance projects
- get_project_details(project_id) — Get project details
- get_project_stats(project_id) — Get project statistics
- get_project_artefacts(project_id) — Get artefacts linked to a project
- get_project_data_risks(project_id) — Get data risks for a project
- get_recent_projects — Recently accessed projects

ACTIVITIES:
- get_activities(project_id) — Get activities (operating practices) for a project
- get_activity_details(project_id, activity_id) — Get activity details
- get_activities_dashboard(project_id) — Activities compliance dashboard

COMPLIANCE OBJECTS (Playbooks):
- get_compliance_objects — List all playbooks / compliance objects
- get_compliance_details(code) — Get playbook description, risks, levels
- get_compliance_ops(code) — Operating practices for a playbook
- get_playbook_artefacts(code) — Artefacts for a playbook
- get_compliance_risks(code) — Risks for a playbook
- get_compliance_statements(code) — Statements for a playbook  
- get_compliance_questions(code) — Questions for a playbook
- get_compliance_projects(code) — Projects linked to a playbook

DEROGATIONS:
- get_derogations — List all derogations
- get_derogations_v2 — Derogations (v2 format)
- get_derogation_reason_types — Available derogation reason types

ARTEFACTS:
- get_artefacts — List all artefacts
- get_artefact_details(artefact_id) — Get artefact details
- get_artefacts_by_project(project_id) — Artefacts for a project
- get_artefacts_dashboard — Artefacts compliance dashboard

OPERATING PRACTICES:
- get_ops — List all global operating practices
- get_op_details(code) — Get operating practice details
- get_op_hierarchy(code) — OP hierarchy

DATA & RISKS:
- get_data_risks — All data risks
- get_heatmap — Risk heat map
- get_trust_level — Trust level metrics
- get_homepage — Homepage summary data

TENANT & USER:
- get_user_tenants — Current user's tenants
- get_tenant_metadata — Tenant configuration metadata
- get_users — List tenant users

ENFORCEMENT:
- get_enforcement_projects — Projects in enforcement
- get_enforcement_activities(project_id) — Enforcement activities for a project

OTHER:
- get_questionnaire(project_id) — Project questionnaire
- debug_auth — Diagnose authentication issues`,

    toolProperties: {
        action: arg.string().describe("The action to perform (e.g. get_projects, get_activities, get_compliance_objects, etc.)"),
        project_id: arg.string().optional().describe("Project GUID — required for project-specific actions"),
        activity_id: arg.string().optional().describe("Activity identifier — required for get_activity_details"),
        code: arg.string().optional().describe("Compliance object or operating practice code"),
        artefact_id: arg.string().optional().describe("Artefact identifier — required for get_artefact_details"),
    },

    handler: async (toolArguments: unknown, context: InvocationContext): Promise<string> => {
        const meta = context.triggerMetadata as Record<string, any> || {};
        const args = (meta.mcptoolargs as Record<string, string>) || {};

        const action = args.action;
        const project_id = args.project_id;
        const activity_id = args.activity_id;
        const code = args.code;
        const artefact_id = args.artefact_id;

        if (!action) {
            return JSON.stringify({ error: "Missing required parameter: action" });
        }

        // Extract the user's Entra token (passed by Foundry Agent via OAuth passthrough)
        const userToken = extractUserToken(meta, toolArguments);

        // ── Debug action ──────────────────────────────────────────────
        if (action === "debug_auth") {
            const { debugAuth } = await import("../shared/prodagoApi");
            const result = await debugAuth(userToken);
            // Include diagnostics about where the token was found
            const transportHeaders = (toolArguments as any)?.transport?.headers;
            return JSON.stringify({
                ...result,
                token_found: !!userToken,
                token_length: userToken?.length ?? 0,
                transport_headers_keys: transportHeaders ? Object.keys(transportHeaders) : [],
                meta_keys: Object.keys(meta),
            }, null, 2);
        }

        // ── Route to appropriate endpoint ──────────────────────────────
        try {
            let path: string;
            let method: "GET" | "POST" | "PUT" = "GET";
            let body: any = undefined;

            switch (action) {
                // Projects
                case "get_projects": path = "/projects"; break;
                case "get_recent_projects": path = "/Projects/recent"; break;
                case "get_project_details":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_project_details" });
                    path = `/projects/${project_id}/details`; break;
                case "get_project_stats":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_project_stats" });
                    path = `/projects/${project_id}/stats`; break;
                case "get_project_artefacts":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_project_artefacts" });
                    path = `/Artefact/project/${project_id}`; break;
                case "get_project_data_risks":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_project_data_risks" });
                    path = `/DataRisk/project/${project_id}`; break;

                // Activities
                case "get_activities":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_activities" });
                    path = `/Activities/${project_id}/v2`; break;
                case "get_activity_details":
                    if (!project_id || !activity_id) return JSON.stringify({ error: "project_id and activity_id are required for get_activity_details" });
                    path = `/Activities/${project_id}/v2/${activity_id}`; break;
                case "get_activities_dashboard":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_activities_dashboard" });
                    path = `/Activities/${project_id}/dashboard`; break;

                // Compliance objects / playbooks
                case "get_compliance_objects": path = "/ComplianceObject"; break;
                case "get_compliance_details":
                    if (!code) return JSON.stringify({ error: "code is required for get_compliance_details" });
                    path = `/ComplianceObject/${code}`; break;
                case "get_compliance_ops":
                    if (!code) return JSON.stringify({ error: "code is required for get_compliance_ops" });
                    path = `/ComplianceObject/${code}/ops`; break;
                case "get_playbook_artefacts":
                    if (!code) return JSON.stringify({ error: "code is required for get_playbook_artefacts" });
                    path = `/ComplianceObject/${code}/artefacts`; break;
                case "get_compliance_risks":
                    if (!code) return JSON.stringify({ error: "code is required for get_compliance_risks" });
                    path = `/ComplianceObject/${code}/risks`; break;
                case "get_compliance_statements":
                    if (!code) return JSON.stringify({ error: "code is required for get_compliance_statements" });
                    path = `/ComplianceObject/${code}/statements`; break;
                case "get_compliance_questions":
                    if (!code) return JSON.stringify({ error: "code is required for get_compliance_questions" });
                    path = `/ComplianceObject/${code}/questions`; break;
                case "get_compliance_projects":
                    if (!code) return JSON.stringify({ error: "code is required for get_compliance_projects" });
                    path = `/ComplianceObject/${code}/projects`; break;

                // Derogations
                case "get_derogations": path = "/Derogation"; break;
                case "get_derogations_v2": path = "/Derogation/v2"; break;
                case "get_derogation_reason_types": path = "/Derogation/reasonTypes"; break;

                // Artefacts
                case "get_artefacts": path = "/Artefact"; break;
                case "get_artefact_details":
                    if (!artefact_id) return JSON.stringify({ error: "artefact_id is required for get_artefact_details" });
                    path = `/Artefact/${artefact_id}`; break;
                case "get_artefacts_by_project":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_artefacts_by_project" });
                    path = `/Artefact/project/${project_id}`; break;
                case "get_artefacts_dashboard": path = "/Artefact/dashboard"; break;

                // Operating practices
                case "get_ops": path = "/OperatingPractice"; break;
                case "get_op_details":
                    if (!code) return JSON.stringify({ error: "code is required for get_op_details" });
                    path = `/OperatingPractice/${code}`; break;
                case "get_op_hierarchy":
                    if (!code) return JSON.stringify({ error: "code is required for get_op_hierarchy" });
                    path = `/OperatingPractice/${code}/hierarchy`; break;

                // Data & risks
                case "get_data_risks": path = "/DataRisk"; break;
                case "get_heatmap": path = "/HeatMap"; break;
                case "get_trust_level": path = "/TrustLevel"; break;
                case "get_homepage": path = "/HomePage"; break;

                // Tenant & users
                case "get_user_tenants": path = "/User/userTenants"; break;
                case "get_tenant_metadata": path = "/Tenant/metadata"; break;
                case "get_users": path = "/User"; break;

                // Enforcement
                case "get_enforcement_projects": path = "/Enforcement/projects"; break;
                case "get_enforcement_activities":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_enforcement_activities" });
                    path = `/Enforcement/${project_id}/activities`; break;

                // Other
                case "get_questionnaire":
                    if (!project_id) return JSON.stringify({ error: "project_id is required for get_questionnaire" });
                    path = `/Questionnaire/${project_id}`; break;

                default:
                    return JSON.stringify({
                        error: `Unknown action: "${action}"`,
                        hint: "Use debug_auth to test authentication, or get_projects to list projects.",
                    });
            }

            const result = await fetchProdagoAPI<any>(path, userToken, method === "GET" ? undefined : { method, body });
            return JSON.stringify(result ?? { success: true });

        } catch (error: any) {
            return JSON.stringify({
                error: error.message,
                action,
                token_found: !!userToken,
            });
        }
    },
});
