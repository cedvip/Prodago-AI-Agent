// ──────────────────────────────────────────────
// Function App module — Consumption plan + Function App + Storage
// ──────────────────────────────────────────────
@description('Azure region for all resources')
param location string

@description('Base name used for resource naming')
param baseName string

@description('Prodago API base URL')
param prodagoApiUrl string

@description('Prodago SaaS URL for token exchange')
param prodagoSaasUrl string

// ── Storage Account (required for Functions runtime) ──
var storageName = replace(toLower('st${baseName}'), '-', '')

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: length(storageName) > 24 ? substring(storageName, 0, 24) : storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
}

// ── App Service Plan (Consumption Y1) ──
resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${baseName}'
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: false
  }
}

// ── Function App ──
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: baseName
  location: location
  kind: 'functionapp'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      nodeVersion: '~20'
      appSettings: [
        { name: 'AzureWebJobsStorage'; value: 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value}' }
        { name: 'FUNCTIONS_WORKER_RUNTIME'; value: 'node' }
        { name: 'FUNCTIONS_EXTENSION_VERSION'; value: '~4' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION'; value: '~20' }
        { name: 'PRODAGO_API_URL'; value: prodagoApiUrl }
        { name: 'PRODAGO_SAAS_URL'; value: prodagoSaasUrl }
      ]
    }
  }
}

output functionAppName string = functionApp.name
output functionAppId string = functionApp.id
output defaultHostName string = functionApp.properties.defaultHostName
output principalId string = functionApp.identity.principalId
