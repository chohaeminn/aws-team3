import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Jwks } from "aws-jwt-verify/jwk";

export interface Principal { id: string; role: "customer" | "admin" }
export type PrincipalResolver = (authorization: string | undefined) => Promise<Principal | undefined>;
export const adminGroup = "refund-demo-admin";

export function createCognitoResolver({ userPoolId, clientId, jwks }: { userPoolId: string; clientId: string; jwks?: Jwks }): PrincipalResolver {
  const verifier = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: "access" });
  if (jwks) verifier.cacheJwks(jwks);
  return async authorization => {
    if (!authorization || authorization.length > 16_384 || !/^Bearer [A-Za-z0-9_.-]+$/i.test(authorization)) return undefined;
    try {
      const payload = await verifier.verify(authorization.slice(7));
      if (!payload.sub) return undefined;
      return { id: payload.sub, role: payload["cognito:groups"]?.includes(adminGroup) ? "admin" : "customer" };
    } catch { return undefined; } // 토큰과 외부 인증 오류 본문은 기록하지 않는다.
  };
}

export function createPrincipalResolver(env: NodeJS.ProcessEnv = process.env): PrincipalResolver {
  if (!env.COGNITO_USER_POOL_ID || !env.COGNITO_CLIENT_ID) return async () => undefined;
  return createCognitoResolver({ userPoolId: env.COGNITO_USER_POOL_ID, clientId: env.COGNITO_CLIENT_ID });
}
