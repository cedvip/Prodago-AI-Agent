# Prodago AI Agent — MCP Server

[![CI/CD](https://github.com/Protecio/prodago-ai-agent/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/Protecio/prodago-ai-agent/actions/workflows/ci-cd.yml)

An **Azure Function App** that exposes the [Prodago](https://prodago.com) governance platform as an **MCP (Model Context Protocol) server**, enabling AI agents to query projects, compliance playbooks, operating practices, and more — with secure user-level authentication via Entra ID.

## Architecture

```
┌──────────────────┐       ┌──────────────────────┐       ┌──────────────────┐
│  Azure AI Agent  │──MCP──▶  Azure Function App  │──API──▶  Prodago API     │
│  (Foundry v2)    │       │  mcp-prodago          │       │  (prod2)         │
└──────────────────┘       └──────────┬───────────┘       └──────────────────┘
                                      │
                              ┌───────▼────────┐
                              │ saas.prodago.com│
                              │ (token exchange)│
                              └────────────────┘
```

**Token flow:** The Foundry Agent forwards the user's Entra ID token → MCP server exchanges it with `saas.prodago.com` → receives a Prodago bearer token + preferred tenant → caches credentials (50 min TTL) → forwards to all API calls.

## Available Actions

The MCP server exposes a single `prodago_api` tool with an `action` parameter that routes to 40+ API endpoints:

| Category | Actions |
|---|---|
| **Projects** | `get_projects`, `get_project_details`, `get_project_stats`, `get_project_artefacts`, `get_project_data_risks`, `get_recent_projects` |
| **Activities** | `get_activities`, `get_activity_details`, `get_activities_dashboard` |
| **Compliance / Playbooks** | `get_compliance_objects`, `get_compliance_details`, `get_compliance_ops`, `get_playbook_artefacts`, `get_compliance_risks`, `get_compliance_statements`, `get_compliance_questions`, `get_compliance_projects` |
| **Derogations** | `get_derogations`, `get_derogations_v2`, `get_derogation_reason_types` |
| **Artefacts** | `get_artefacts`, `get_artefact_details`, `get_artefacts_by_project`, `get_artefacts_dashboard` |
| **Operating Practices** | `get_ops`, `get_op_details`, `get_op_hierarchy` |
| **Data & Risks** | `get_data_risks`, `get_heatmap`, `get_trust_level`, `get_homepage` |
| **Tenant & Users** | `get_user_tenants`, `get_tenant_metadata`, `get_users` |
| **Enforcement** | `get_enforcement_projects`, `get_enforcement_activities` |
| **Other** | `get_questionnaire`, `debug_auth` |

## Project Structure

```
mcp-prodago/
├── src/
│   ├── index.ts                    # App setup (HTTP streaming)
│   ├── functions/
│   │   └── prodagoApi.ts           # MCP tool registration & action routing
│   ├── shared/
│   │   └── prodagoApi.ts           # API client, auth exchange, token caching
│   ├── create-agent.ts             # Foundry v2 agent creation script
│   └── inspect-agent.ts            # Agent inspection utility
├── infra/
│   ├── main.bicep                  # IaC orchestrator
│   └── modules/
│       ├── function-app.bicep      # Consumption Function App + Storage
│       ├── easyauth.bicep          # EasyAuth v2 + Entra ID config
│       └── ai-foundry.bicep        # AI Services + Project + MCP connection
├── host.json                       # Azure Functions host config (MCP extension)
├── .github/workflows/ci-cd.yml     # CI/CD pipeline
├── package.json
└── tsconfig.json
```

## Prerequisites

- **Node.js** 20+
- **Azure Functions Core Tools** v4
- **Azure CLI** (for infrastructure deployment)
- An **Entra ID** app registration configured for EasyAuth

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure local settings

Create a `local.settings.json`:

```json
{
    "IsEncrypted": false,
    "Values": {
        "AzureWebJobsStorage": "",
        "AzureWebJobsSecretStorageType": "Files",
        "FUNCTIONS_WORKER_RUNTIME": "node",
        "PRODAGO_API_URL": "https://prodago-api-prod2.azurewebsites.net/api",
        "PRODAGO_SAAS_URL": "https://saas.prodago.com/",
        "PRODAGO_API_TOKEN": "<your-token-for-local-testing>"
    }
}
```

### 3. Build & run locally

```bash
npm run build
npm start
```

The MCP endpoint will be available at `http://localhost:7071/runtime/webhooks/mcp`.

## Deployment

### Deploy Function App only

```bash
npm run deploy
```

### Deploy infrastructure (Bicep)

```bash
# Preview changes
npm run deploy:infra:preview

# Apply
npm run deploy:infra
```

### Create / update the AI Agent

```bash
npm run deploy:agent
```

### Full deployment (infra → function → agent)

```bash
npm run deploy:all
```

## CI/CD

The repository includes a GitHub Actions workflow (`.github/workflows/ci-cd.yml`) that:

1. **Build & Validate** — runs on every push and PR to `main` (checkout → Node 20 → `npm ci` → `npm run build`)
2. **Deploy to Azure** — runs on push to `main` only, using `Azure/functions-action` with a publish profile

### Setup

Add the following secret to the GitHub repository (**Settings → Secrets → Actions**):

| Secret | Value |
|---|---|
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | Download from Azure Portal → Function App → **Get Publish Profile** |

## Tech Stack

- **Runtime**: Azure Functions v4 (Node.js 20, TypeScript)
- **Protocol**: MCP (Model Context Protocol) via Azure Functions MCP extension
- **IaC**: Bicep (Function App, EasyAuth, AI Foundry)
- **Auth**: Entra ID (EasyAuth v2) with dynamic token exchange via `saas.prodago.com`
- **AI Agent**: Azure AI Foundry v2 with `gpt-4.1`

## License

Proprietary — © [Protecio](https://protecio.com)
