// Schema types from contracts/openapi.yaml. Regenerate with npm run generate:api.
export interface components {
  schemas: {
    Error: { error: string };
    OK: { ok: boolean };
    Session: {
      id: string;
      username: string;
      role: "admin" | "user";
      must_change_password: boolean;
      csrf_token: string;
    };
    Login: { username: string; password: string };
    PasswordChange: { current_password: string; new_password: string };
    Key: {
      id: string;
      name: string;
      mask: string;
      created_at: string;
      expires_at: string | null;
      revoked_at: string | null;
      last_used_at: string | null;
    };
    KeyInput: { name: string; expires_at?: string | null };
    KeyCreated: {
      id: string;
      name: string;
      key: string;
      expires_at: string | null;
    };
    Bridge: {
      id: string;
      name: string;
      agent_version: string;
      os: string;
      last_connected_at: string;
      online: boolean;
      core_available: boolean;
    };
    Layout: { version: number; document: unknown };
    User: {
      id: string;
      username: string;
      role: "admin" | "user";
      status: "active" | "disabled";
      must_change_password: boolean;
    };
    UserInput: { username: string; password: string };
    UserPatch: { status?: "active" | "disabled"; password?: string };
    UserCreated: { id: string; username: string };
    Connection: {
      bridge_id: string;
      user_id: string;
      connection_id: string;
      tunnels: number;
      core_available: boolean;
    };
  };
}
