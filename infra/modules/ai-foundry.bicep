// ──────────────────────────────────────────────
// AI Foundry module — AI Services + Project + MCP Connection
// ──────────────────────────────────────────────
@description('Azure region')
param location string

@description('Base name for AI resources')
param aiBaseName string

@description('MCP server URL (with function key)')
param mcpServerUrl string

@description('Entra ID Tenant ID')
param tenantId string

@description('Entra ID Client ID for MCP app')
param entraClientId string

// ── AI Services Account ──
resource aiAccount 'Microsoft.CognitiveServices/accounts@2025-04-01-preview' = {
  name: '${aiBaseName}-resource'
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: '${aiBaseName}-resource'
    publicNetworkAccess: 'Enabled'
    apiProperties: {}
  }
}

// ── AI Foundry Project ──
resource aiProject 'Microsoft.CognitiveServices/accounts/projects@2025-04-01-preview' = {
  parent: aiAccount
  name: aiBaseName
  location: location
  properties: {}
}

// ── MCP Connection (OAuth2, RemoteTool) ──
resource mcpConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-04-01-preview' = {
  parent: aiProject
  name: 'mcp-prodago'
  properties: {
    authType: 'OAuth2'
    category: 'RemoteTool'
    target: mcpServerUrl
    isDefault: true
    #disable-next-line BCP037
    authorizationUrl: 'https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize'
    #disable-next-line BCP037
    tokenUrl: 'https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token'
    #disable-next-line BCP037
    metadata: {
      type: 'custom_MCP'
    }
  }
}

output aiAccountName string = aiAccount.name
output aiProjectName string = aiProject.name
output aiEndpoint string = aiAccount.properties.endpoint
output mcpConnectionId string = mcpConnection.id
