import { IsolationError } from "./registry.js";

export type MutationClass =
  | "MAIN_CONTENT_MUTATION"
  | "TASK_WORKTREE_MUTATION"
  | "WORKTREE_CONTROL_PLANE";

export type ControlPlaneOperation = "task_create" | "task_register" | "task_cleanup";

export function denyMainContentMutation(operation: string): never {
  throw new IsolationError("MAIN_WORKTREE_READ_ONLY", `${operation} is not allowed`);
}

export function authorizeControlPlane(operation: ControlPlaneOperation): void {
  if (!["task_create", "task_register", "task_cleanup"].includes(operation)) {
    throw new IsolationError("CONTROL_PLANE_OPERATION_DENIED", operation);
  }
}

export function authorizeMutation(mutationClass: MutationClass, operation: string): void {
  if (mutationClass === "MAIN_CONTENT_MUTATION") denyMainContentMutation(operation);
  if (mutationClass === "WORKTREE_CONTROL_PLANE") authorizeControlPlane(operation as ControlPlaneOperation);
}
