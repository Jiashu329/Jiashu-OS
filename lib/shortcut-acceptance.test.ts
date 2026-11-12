import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildShortcutAcceptance, SHORTCUT_DEVICE_CHECKS, SHORTCUT_GUIDE_VERSION, renderShortcutAcceptancePanel } from './shortcut-acceptance.ts';
import { SHORTCUT_TEMPLATES } from './shortcut-templates.ts';

const template = { ...SHORTCUT_TEMPLATES[0], guideVersion: SHORTCUT_GUIDE_VERSION };
const input = () => ({ metrics: ['steps'], checks: Object.fromEntries(Object.keys(SHORTCUT_DEVICE_CHECKS).map((key) => [key,true])) as Record<keyof typeof SHORTCUT_DEVICE_CHECKS,boolean>,
  iosVersion: '18.6', serverStartedAt: '2026-11-12T01:00:00Z', serverConfirmed: true, phoneConfirmed: true, automation: 'not-configured' as const });

test('a device acceptance report requires fresh server/phone confirmation and every explicit manual check', () => {
  const report = buildShortcutAcceptance(input(), template, Date.parse('2026-11-12T02:00:00Z'));
  assert.equal(report.verification,'user-confirmed-on-device');assert.equal(report.templateContentVerifiedByWebsite,false);
  assert.equal(report.guideVersion,'2026-11-12');assert.equal(report.iosVersion,'18.6');assert.deepEqual(report.metrics,['steps']);
  for(const key of Object.keys(SHORTCUT_DEVICE_CHECKS))assert.throws(()=>buildShortcutAcceptance({...input(),checks:{...input().checks,[key]:false}},template));
  for(const patch of [{serverConfirmed:false},{phoneConfirmed:false},{serverStartedAt:''},{metrics:[]},{metrics:['weight']},{metrics:['steps','steps']},{iosVersion:'<img>'}])assert.throws(()=>buildShortcutAcceptance({...input(),...patch},template));
  assert.doesNotMatch(JSON.stringify(report),/jso_sync_|token|healthValue|email/);
});

test('template evidence preserves an explicit unverified boundary and never accepts invented links or versions', () => {
  assert.throws(()=>buildShortcutAcceptance(input(),{...template,url:'https://untrusted.example/shortcut'}));
  assert.throws(()=>buildShortcutAcceptance(input(),{...template,guideVersion:'latest'}));
  const html=renderShortcutAcceptancePanel(SHORTCUT_TEMPLATES[0]);
  assert.match(html,/真机核对后填写/);assert.match(html,/不上传服务器/);assert.match(html,/id="template-save-acceptance"[^>]*disabled/);
  assert.equal((html.match(/data-device-check="/g)||[]).length,5);
});

test('every rendered acceptance script parses after HTML template interpolation', () => {
  for (const template of SHORTCUT_TEMPLATES) {
    const html = renderShortcutAcceptancePanel(template);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    for (const [, source] of scripts) assert.doesNotThrow(() => new vm.Script(source, { filename: 'shortcut-acceptance-' + template.id + '.js' }));
  }
});
