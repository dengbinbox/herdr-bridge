import type { components } from "./api.generated";
export type User = components["schemas"]["Session"];
export type Bridge = components["schemas"]["Bridge"];
export type KeyInfo = components["schemas"]["Key"];
export type ManagedUser = components["schemas"]["User"];
export type ConnectionInfo = components["schemas"]["Connection"];
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let csrf = "";
export function setCSRF(value: string) {
  csrf = value;
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new APIError(
      response.status,
      body.error || `HTTP ${response.status}`,
    );
  return body;
}
