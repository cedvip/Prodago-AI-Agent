// ──────────────────────────────────────────────
// MCP Prodago — Main IaC Orchestrator
// Deploys: Function App + EasyAuth + AI Foundry + MCP Connection
// ──────────────────────────────────────────────
targetScope = 'resourceGroup'

@description('Azure region for all resources')
param location string = 'canadaeast'

@description('Base name for the MCP Function App')
param mcpAppName string = 'mcp-prodago'

@description('Base name for AI Foundry resources')
param aiBaseName string = 'agent-prodago-ai2'

@description('Prodago API base URL')
param prodagoApiUrl string = 'https://prodago-api-prod2.azurewebsites.net/api'

@description('Prodago SaaS URL for token exchange')
param prodagoSaasUrl string = 'https://saas.prodago.com/'

@description('Entra ID Client ID for the MCP app registration')
param entraClientId string

@description('Entra ID Tenant ID')
param tenantId string

// ── 1. Function App ──
module functionApp 'modules/function-app.bicep' = {
  name: 'deploy-function-app'
  params: {
    location: location
    baseName: mcpAppName
    prodagoApiUrl: prodagoApiUrl
    prodagoSaasUrl: prodagoSaasUrl
  }
}

// ── 2. EasyAuth (depends on Function App) ──
module easyAuth 'modules/easyauth.bicep' = {
  name: 'deploy-easyauth'
  params: {
    functionAppName: functionApp.outputs.functionAppName
    entraClientId: entraClientId
    tenantId: tenantId
  }
}

// ── 3. AI Foundry + MCP Connection ──
module aiFoundry 'modules/ai-foundry.bicep' = {
  name: 'deploy-ai-foundry'
  params: {
    location: location
    aiBaseName: aiBaseName
    mcpServerUrl: 'https://${functionApp.outputs.defaultHostName}/runtime/webhooks/mcp'
    tenantId: tenantId
    entraClientId: entraClientId
  }
}

// ── Outputs ──
output functionAppName string = functionApp.outputs.functionAppName
output functionAppUrl string = 'https://${functionApp.outputs.defaultHostName}'
output aiEndpoint string = aiFoundry.outputs.aiEndpoint
output aiProjectName string = aiFoundry.outputs.aiProjectName
output mcpConnectionId string = aiFoundry.outputs.mcpConnectionId
