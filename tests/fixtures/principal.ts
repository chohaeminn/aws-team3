import type { PrincipalResolver } from "../../src/server/auth/principal.js";
// Tests explicitly inject a principal. There is no runtime environment flag to bypass authentication.
export const testPrincipal: PrincipalResolver = async () => ({ id: "fixture-admin", role: "admin" });
