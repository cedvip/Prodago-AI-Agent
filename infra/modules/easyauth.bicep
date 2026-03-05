// ──────────────────────────────────────────────
// EasyAuth v2 module — Entra ID + AllowAnonymous
// ──────────────────────────────────────────────
@description('Name of the Function App to configure')
param functionAppName string

@description('Entra ID Client ID for the MCP app registration')
param entraClientId string

@description('Entra ID Tenant ID')
param tenantId string

resource functionApp 'Microsoft.Web/sites@2023-12-01' existing = {
  name: functionAppName
}

resource authSettings 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: entraClientId
          openIdIssuer: 'https://login.microsoftonline.com/${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            'api://${entraClientId}'
            entraClientId
            'https://${functionAppName}.azurewebsites.net'
          ]
        }
        login: {
          disableWWWAuthenticate: false
        }
      }
    }
    login: {
      tokenStore: {
        enabled: true
      }
    }
    httpSettings: {
      requireHttps: true
      routes: {
        apiPrefix: '/.auth'
      }
    }
  }
}
