/**
 * Creates or updates the Prodago v2 agent with MCP tool + OAuth passthrough.
 *
 * v2 Agent API: POST /agents (not /assistants)
 * Schema: { name, definition: { kind: "prompt", model, instructions, tools } }
 * MCP tool supports project_connection_id for OAuth identity passthrough.
 */
import { AzureCliCredential } from "@azure/identity";

const ENDPOINT = "https://agent-prodago-ai2-resource.services.ai.azure.com/api/projects/agent-prodago-ai2";
const API_VERSION = "2025-05-15-preview";
const AGENT_NAME = "agent-prodago-v2";
const MCP_URL = process.env.MCP_URL ?? "https://mcp-prodago.azurewebsites.net/runtime/webhooks/mcp?code=<MCP_SYSTEM_KEY>";
const MCP_CONNECTION_ID = "/subscriptions/ddde34b2-0c44-438c-9b2b-5e6c22534634/resourceGroups/rg-agent-prodago-ai2/providers/Microsoft.CognitiveServices/accounts/agent-prodago-ai2-resource/projects/agent-prodago-ai2/connections/mcp-prodago";

const INSTRUCTIONS = `You are the Prodago AI Governance Assistant — a professional, bilingual (EN/FR) advisor on governance, compliance, and risk management.

## Language
- Reply in the same language as the user (English or French).
- Professional, clear, structured tone.

## Style
- Never expose tool names, API details, or MCP internals.
- Use tables, lists, and structured summaries.
- Add context: flag overdue items, high derogation counts, health issues.
- For large datasets: summarize first, offer to drill down.

## Tool Usage (prodago_api)
Use the prodago_api tool with an 'action' parameter:
- "what projects do I have?" → action: get_projects
- "activities for project X" → action: get_activities, project_id: <id>
- "playbooks / compliance objects" → action: get_compliance_objects
- "details for playbook X" → action: get_compliance_details, code: <code>
- "derogations" → action: get_derogations
- "data risks" → action: get_data_risks
- "my tenants" → action: get_user_tenants
- "auth issues" → action: debug_auth

## Format
- Markdown: bold headers, tables, bullets.
- Summarize large datasets, then offer details.`;


const ALL_TOOLS = ["prodago_api"];

async function main() {
    const credential = new AzureCliCredential();
    const token = await credential.getToken("https://ai.azure.com/.default");
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token.token}`,
    };

    // 1. Check if agent already exists
    console.log(`=== Checking for existing agent: ${AGENT_NAME} ===`);
    const getRes = await fetch(
        `${ENDPOINT}/agents/${AGENT_NAME}?api-version=${API_VERSION}`,
        { headers }
    );

    const definition: any = {
        kind: "prompt",
        model: "gpt-41",
        instructions: INSTRUCTIONS,
        tools: [{
            type: "mcp",
            server_label: "prodago_mcp",
            server_url: MCP_URL,
            allowed_tools: ALL_TOOLS,
            project_connection_id: MCP_CONNECTION_ID,
            require_approval: "never",
        }],
        temperature: 0.3,
    };

    if (getRes.ok) {
        // Agent exists — update it (POST creates a new version)
        const existing = await getRes.json() as any;
        const currentVer = existing.versions?.latest?.version || "?";
        console.log(`Found existing agent: ${existing.id}, version: ${currentVer}`);
        console.log("Updating with new definition...");

        const updateRes = await fetch(
            `${ENDPOINT}/agents/${AGENT_NAME}?api-version=${API_VERSION}`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({ definition }),
            }
        );

        if (updateRes.ok) {
            // POST may return empty body — re-fetch to confirm
            const verifyRes = await fetch(
                `${ENDPOINT}/agents/${AGENT_NAME}?api-version=${API_VERSION}`,
                { headers }
            );
            const verified = await verifyRes.json() as any;
            const newVer = verified.versions?.latest?.version || "?";
            console.log("\n=== AGENT UPDATED SUCCESSFULLY ===");
            console.log("ID:", verified.id || AGENT_NAME);
            console.log("Version:", `${currentVer} -> ${newVer}`);
            console.log(`AZURE_EXISTING_AGENT_ID=${verified.id || AGENT_NAME}`);
        } else {
            const errText = await updateRes.text();
            console.error("UPDATE ERROR:", errText);
            process.exit(1);
        }
    } else {
        // Agent doesn't exist — create it
        console.log("Agent not found, creating new one...");
        const createRes = await fetch(
            `${ENDPOINT}/agents?api-version=${API_VERSION}`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({ name: AGENT_NAME, definition }),
            }
        );
        const createData = await createRes.json() as any;

        if (createRes.ok) {
            console.log("\n=== AGENT CREATED SUCCESSFULLY ===");
            console.log("ID:", createData.id || createData.name);
            console.log("Version:", createData.versions?.latest?.version);
            console.log(`AZURE_EXISTING_AGENT_ID=${createData.id || AGENT_NAME}`);
        } else {
            console.error("CREATE ERROR:", JSON.stringify(createData, null, 2));
            process.exit(1);
        }
    }
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
