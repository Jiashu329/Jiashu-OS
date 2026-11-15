import { env } from 'cloudflare:workers';
import { createFinanceBookHandlers } from '../../../../lib/finance-books-api';
import { apiUser, unauthenticated, json } from '../../_shared';

export const financeBookHandlers = createFinanceBookHandlers({
  user: apiUser, unauthenticated,
  database() { if (!env.DB) throw new Error('Finance database unavailable'); return env.DB; },
  json,
});
