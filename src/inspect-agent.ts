/**
 * Quick script to inspect the v2 Foundry Agent configuration.
 * Run: npx ts-node src/inspect-agent.ts
 */
import { AzureCliCredential } from "@azure/identity";

const ENDPOINT = "https://agent-prodago-ai2-resource.services.ai.azure.com/api/projects/agent-prodago-ai2";
const API_VERSION = "2025-05-15-preview";
const AGENT_NAME = "agent-prodago-v2";

async function main() {
    const credential = new AzureCliCredential();
    const token = await credential.getToken("https://ai.azure.com/.default");
    const headers = {
        Authorization: `Bearer ${token.token}`,
    };

    console.log("=== Inspecting v2 Agent:", AGENT_NAME, "===\n");

    const res = await fetch(
        `${ENDPOINT}/agents/${AGENT_NAME}?api-version=${API_VERSION}`,
        { headers }
    );

    if (!res.ok) {
        console.error("ERROR:", await res.text());
        process.exit(1);
    }

    const agent = await res.json() as any;
    const def = agent.versions?.latest?.definition;

    console.log("ID:", agent.id);
    console.log("Version:", agent.versions?.latest?.version);
    console.log("Kind:", def?.kind);
    console.log("Model:", def?.model);
    console.log("Temperature:", def?.temperature);
    console.log("\nTools:", JSON.stringify(def?.tools, null, 2));
    console.log("\nInstructions:", def?.instructions?.substring(0, 200) + "...");
}

main().catch(console.error);
