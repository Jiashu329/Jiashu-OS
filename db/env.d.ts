declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AI_PROVIDER?: string;
    MINIMAX_API_KEY?: string;
    MINIMAX_MODEL?: string;
    MINIMAX_REGION?: string;
  }
}
