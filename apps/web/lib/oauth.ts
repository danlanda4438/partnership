// OAuth 2.1 discovery documents for the MCP server (MCP authorization spec):
// RFC 9728 protected resource metadata + RFC 8414 authorization server metadata.

export function originOf(req: Request): string {
  return new URL(req.url).origin;
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["bot"],
    resource_name: "Gleeday Operations",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["bot"],
  };
}

export const noStore = { "cache-control": "no-store", pragma: "no-cache" };
