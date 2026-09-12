export type ActionPermissionGrant = {
  subjectId: string;
  companyId: string;
  action: string;
  scope: "company" | "object";
  objectId?: string;
};

export type ActionPermissionCheck = {
  grants: ActionPermissionGrant[];
  subjectId: string;
  companyId: string;
  action: string;
  objectId?: string;
};

export class ActionPermissionDeniedError extends Error {
  constructor(action: string) {
    super(`Missing permission ${action}`);
    this.name = "ActionPermissionDeniedError";
  }
}

export function hasActionPermission(input: ActionPermissionCheck): boolean {
  return input.grants.some((grant) => {
    if (grant.subjectId !== input.subjectId) return false;
    if (grant.companyId !== input.companyId) return false;
    if (grant.action !== input.action) return false;
    if (grant.scope === "company") return true;
    return Boolean(input.objectId) && grant.objectId === input.objectId;
  });
}

export function assertActionPermission(input: ActionPermissionCheck): void {
  if (!hasActionPermission(input)) throw new ActionPermissionDeniedError(input.action);
}
