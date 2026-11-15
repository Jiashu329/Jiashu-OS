import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createExtensionZip, extensionPackage } from './package-douban-extension.mjs';

export const SITES_ORIGIN = 'https://jiashu-life-os-health.jiashuh329.chatgpt.site';
export const DEFAULT_SELFHOST_ORIGIN = 'https://www.treefund.asia';
export const SELFHOST_EXTENSION_VERSION = '1.0.7';
export const SELFHOST_EXTENSION_OUTPUT = fileURLToPath(new URL('../outputs/selfhost-extension.generated.ts', import.meta.url));

function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Self-host extension origin must be an HTTPS origin'); }
  if (typeof value !== 'string' || value.includes('*') || url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || ![url.origin, url.origin + '/'].includes(value)) {
    throw new Error('Self-host extension origin must be an HTTPS origin without credentials, path, query, or wildcard');
  }
  return url.origin;
}

function replaceOnce(source, original, replacement) {
  if (source.split(original).length !== 2) throw new Error('Extension worker contract changed; review the self-host package transformation');
  return source.replace(original, replacement);
}

function selfhostWorker(source, origins) {
  let worker = replaceOnce(source, 'export const WEBSITE_ORIGIN = ' + JSON.stringify(SITES_ORIGIN).replaceAll('"', "'") + ';',
    'export const WEBSITE_ORIGIN = ' + JSON.stringify(SITES_ORIGIN) + ';\nexport const WEBSITE_ORIGINS = Object.freeze(' + JSON.stringify(origins) + ');');
  worker = replaceOnce(worker, "export const EXTENSION_VERSION = '1.0.6';", 'export const EXTENSION_VERSION = ' + JSON.stringify(SELFHOST_EXTENSION_VERSION) + ';');
  worker = replaceOnce(worker, 'url.origin === WEBSITE_ORIGIN &&', 'WEBSITE_ORIGINS.includes(url.origin) &&');
  worker = replaceOnce(worker, 'function validRequest(message) {', 'function senderOrigin(sender) { return new URL(sender.url).origin; }\nfunction validRequest(message) {');
  // Origin joins the existing owner/profile/tab binding because this package
  // permits two independent sites, which may both be visited in the same tab.
  worker = replaceOnce(worker,
    'return job && job.ownerKey === message.ownerKey && job.profileId === message.profileId && job.websiteTabId === sender.tab.id;',
    'return job && job.ownerKey === message.ownerKey && job.profileId === message.profileId && job.websiteTabId === sender.tab.id && job.websiteOrigin === senderOrigin(sender);');
  worker = replaceOnce(worker,
    'return run && run.id === message.runId && run.ownerKey === message.ownerKey && run.profileId === message.profileId && run.websiteTabId === sender.tab.id;',
    'return run && run.id === message.runId && run.ownerKey === message.ownerKey && run.profileId === message.profileId && run.websiteTabId === sender.tab.id && run.websiteOrigin === senderOrigin(sender);');
  worker = replaceOnce(worker,
    '&& active.ownerKey === job.ownerKey && active.profileId === job.profileId && active.websiteTabId === job.websiteTabId;',
    '&& active.ownerKey === job.ownerKey && active.profileId === job.profileId && active.websiteTabId === job.websiteTabId && active.websiteOrigin === job.websiteOrigin;');
  worker = replaceOnce(worker, 'websiteTabId: sender.tab.id, domain: message.domain,',
    'websiteTabId: sender.tab.id, websiteOrigin: senderOrigin(sender), domain: message.domain,');
  worker = replaceOnce(worker,
    'const owned = active && active.ownerKey === message.ownerKey && active.profileId === message.profileId && active.websiteTabId === sender.tab.id;',
    'const owned = active && active.ownerKey === message.ownerKey && active.profileId === message.profileId && active.websiteTabId === sender.tab.id && active.websiteOrigin === senderOrigin(sender);');
  worker = replaceOnce(worker,
    "if (active.websiteTabId !== sender.tab.id || active.ownerKey === message.ownerKey) return failure('RUN_BUSY');",
    "if (active.websiteTabId !== sender.tab.id || active.websiteOrigin !== senderOrigin(sender) || active.ownerKey === message.ownerKey) return failure('RUN_BUSY');");
  return replaceOnce(worker, 'websiteTabId: sender.tab.id, step: 0,',
    'websiteTabId: sender.tab.id, websiteOrigin: senderOrigin(sender), step: 0,');
}

/** Build from the checked stock package without modifying its source or ZIP. */
export async function selfhostExtensionPackage({ origin = DEFAULT_SELFHOST_ORIGIN, outputPath = SELFHOST_EXTENSION_OUTPUT, write = false } = {}) {
  const origins = [...new Set([SITES_ORIGIN, publicOrigin(origin)])];
  const stock = await extensionPackage(true);
  const files = stock.files.map(([name, value]) => {
    if (name === 'manifest.json') {
      const manifest = JSON.parse(value.toString('utf8'));
      manifest.version = SELFHOST_EXTENSION_VERSION;
      manifest.externally_connectable.matches = origins.map(allowed => allowed + '/*');
      return [name, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')];
    }
    if (name === 'background.js') return [name, Buffer.from(selfhostWorker(value.toString('utf8'), origins))];
    if (name === 'README.md') return [name, Buffer.from(value.toString('utf8')
      + '\n## 独立部署测试站\n\n此安装包版本为 ' + SELFHOST_EXTENSION_VERSION + '，仅允许以下两个指定站点的 `/life/douban` 页面连接：\n\n'
      + origins.map(allowed => '- ' + allowed).join('\n')
      + '\n\n两个站点的同步分别绑定发起页面，不能相互接管；安装包沿用原扩展标识和豆瓣访问权限。更新安装包后，请在浏览器扩展管理页重新加载。\n')];
    return [name, Buffer.from(value)];
  });
  const archive = createExtensionZip(files);
  const output = '// Generated by scripts/package-selfhost-extension.mjs; do not edit.\n'
    + 'export const DOUBAN_EXTENSION_ARCHIVE_BASE64 = ' + JSON.stringify(archive.toString('base64')) + ';\n';
  if (write) { await mkdir(dirname(outputPath), { recursive: true }); await writeFile(outputPath, output); }
  return { archive, files, extensionId: stock.extensionId, origins, output, outputPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.slice(2).some(argument => argument !== '--check')) throw new Error('Only --check is supported');
  const check = process.argv.includes('--check');
  const result = await selfhostExtensionPackage({ origin: process.env.SELFHOST_PUBLIC_ORIGIN || DEFAULT_SELFHOST_ORIGIN, write: !check });
  if (check && await readFile(result.outputPath, 'utf8') !== result.output) throw new Error('Self-host extension package is stale; rebuild it');
  process.stdout.write(JSON.stringify({ extensionId: result.extensionId, origins: result.origins, files: result.files.length, bytes: result.archive.length, checked: check }) + '\n');
}
