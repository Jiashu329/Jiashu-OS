declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    APP_OWNER_USER_ID?: string;
    APP_OWNER_EMAIL?: string;
    AI_PROVIDER?: string;
    MINIMAX_API_KEY?: string;
    MINIMAX_MODEL?: string;
    MINIMAX_REGION?: string;
    AI_SETTINGS_ENCRYPTION_KEY?: string;
  }
}
