import { generateKeyPairSync, sign } from "node:crypto";
import { createCognitoResolver } from "../../src/server/auth/principal.js";
export const poolId = "ap-northeast-2_Test123";
export const clientId = "fixtureclient123456";
export const customerA = "11111111-1111-4111-8111-111111111111";
export const customerB = "22222222-2222-4222-8222-222222222222";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
export const jwks = { keys: [{ kty: "RSA", n: jwk.n!, e: jwk.e!, alg: "RS256", use: "sig", kid: "local-test-key" }] };
export const verifiedPrincipal = createCognitoResolver({ userPoolId: poolId, clientId, jwks });
export function signedToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "local-test-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: customerA, iss: `https://cognito-idp.ap-northeast-2.amazonaws.com/${poolId}`,
    client_id: clientId, token_use: "access", scope: "openid profile", iat: now, exp: now + 900, ...overrides })).toString("base64url");
  const message = `${header}.${payload}`;
  return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
}
