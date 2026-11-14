import { apiUser, unauthenticated } from '../../api/_shared';
import { DOUBAN_EXTENSION_ARCHIVE_BASE64 } from '../../../lib/douban-extension-package.generated';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await apiUser(); if (!user) return unauthenticated();
  const bytes = Uint8Array.from(atob(DOUBAN_EXTENSION_ARCHIVE_BASE64), char => char.charCodeAt(0));
  return new Response(bytes, { headers: {
    'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="jiashu-douban-extension.zip"',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}
