const icons = {
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/><path d="M3 12h4l2-4 4 8 2-4h6"/>',
  wallet: '<path d="M20 8V6a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v10H5a3 3 0 0 1-3-3V7"/><path d="M20 12h-5v4h5M5 6h12"/>',
  leaf: '<path d="M20 3C9 2 3 6 5 13c2 7 13 7 15-10Z"/><path d="M3 21 15 9"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
};

function icon(name: keyof typeof icons, className = ''): string {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export interface SelfhostLoginPageOptions { csrf: string; returnTo: string; error?: string }

const brandLogo = '<svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" fill="none" aria-hidden="true"><rect width="192" height="192" rx="34" fill="#123e32"/><circle cx="96" cy="49" r="11" fill="#df874d"/><path d="M86 66h20v48c0 24-12 38-30 38-17 0-27-12-28-29h18c1 7 4 11 10 11 7 0 10-7 10-20V66Z" fill="#f6f4ee"/><path d="M106 118c1-30 17-46 44-46-4 24-15 31-30 35-7 2-11 6-14 11Z" fill="#f6f4ee"/></svg>';

export function renderSelfhostLoginPage({ csrf, returnTo, error = '' }: SelfhostLoginPageOptions): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#f4f5f7">
  <meta name="description" content="登录 Jiashu OS，在一个安静的空间里，关照健康、理清财务、记录生活。">
  <meta name="robots" content="noindex,nofollow">
  <title>登录 · Jiashu OS</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #253148; background: #fff; font-synthesis: none; -webkit-text-size-adjust: 100%; text-rendering: optimizeLegibility; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, input { font: inherit; }
    a { color: inherit; text-decoration: none; -webkit-tap-highlight-color: transparent; }
    a:focus-visible, summary:focus-visible, input:focus-visible, button:focus-visible { outline: 3px solid #5574b5; outline-offset: 6px; }
    ::selection { color: #253148; background: #dce5f4; }
    .icon { width: 22px; height: 22px; flex-shrink: 0; }
    .login-shell { min-height: 100svh; display: grid; grid-template-columns: 55% 45%; }
    .story { position: relative; display: flex; flex-direction: column; overflow: hidden; min-height: 100svh; padding: 42px 9% 32px; background: #f0f2f6; }
    .story::before { content: ""; position: absolute; width: 600px; height: 600px; right: -150px; top: 210px; border-radius: 50%; background: radial-gradient(circle, #dce5f2 0%, #e7ecf4 36%, transparent 70%); pointer-events: none; }
    .brand { display: inline-flex; align-items: center; gap: 11px; position: relative; width: fit-content; }
    .brand .brand-logo { width: 36px; height: 36px; border-radius: 11px; }
    .brand-name { font-size: 21px; font-weight: 650; letter-spacing: -.7px; }
    .brand-name span { color: #788499; font-weight: 400; }
    .story-content { position: relative; width: 100%; max-width: 570px; margin: auto; padding-top: 62px; }
    .eyebrow { display: flex; align-items: center; gap: 9px; color: #6c7c94; font-size: 10px; line-height: 1.5; font-weight: 600; letter-spacing: 2.8px; }
    .eyebrow::before { content: ""; width: 23px; height: 1px; background: #8195b7; }
    .story h2 { font-size: clamp(38px, 4.15vw, 62px); font-weight: 550; letter-spacing: -2.4px; line-height: 1.42; margin: 23px 0 21px; }
    .story h2 span { color: #6380b2; }
    .story-intro { color: #718096; font-size: 14px; line-height: 1.95; letter-spacing: .5px; margin: 0; }
    .universe { position: relative; height: 320px; width: 100%; margin: 18px 0 6px; isolation: isolate; }
    .orbit { position: absolute; left: 50%; top: 50%; width: 264px; height: 264px; transform: translate(-50%, -50%); border: 1px solid #ced8e7; border-radius: 50%; }
    .orbit::before, .orbit::after { content: ""; position: absolute; inset: -39px; border: 1px dashed #d6deea; border-radius: 50%; }
    .orbit::after { inset: 39px; border: 1px solid #d8e0ec; }
    .orbit-dot { position: absolute; top: 49px; left: 22px; width: 10px; height: 10px; background: #96accb; border: 3px solid #edf1f6; border-radius: 50%; box-shadow: 0 0 0 1px #c8d4e5; }
    .orbit-dot.second { top: auto; left: auto; right: 18px; bottom: 51px; width: 8px; height: 8px; background: #c0ad97; }
    .core { position: absolute; left: 50%; top: 50%; width: 105px; height: 105px; display: grid; place-items: center; transform: translate(-50%, -50%) rotate(-8deg); border: 1px solid #fff; border-radius: 29px; background: linear-gradient(145deg, #fff, #e8edf5); box-shadow: 0 18px 35px #566a8b16, inset 0 2px 3px #fff; }
    .core .brand-logo { width: 69px; height: 69px; border-radius: 19px; box-shadow: 0 4px 12px #123e3220; }
    .float-card { position: absolute; background: #ffffffdf; border: 1px solid #fff; border-radius: 15px; box-shadow: 0 12px 28px #455f8910; backdrop-filter: blur(10px); animation: float 7s ease-in-out infinite; }
    .health-card { left: 0; top: 134px; padding: 17px 18px 15px; width: 180px; transform: rotate(-5deg); }
    .card-top { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; }
    .card-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; background: #edf2fa; color: #6c86b4; }
    .card-icon .icon { width: 15px; height: 15px; }
    .health-card .card-icon { background: #e9f2ed; color: #78958a; }
    .health-line { width: 100%; height: 38px; margin-top: 9px; overflow: visible; }
    .card-foot { font-size: 9px; color: #8a96a7; margin-top: 7px; letter-spacing: .5px; }
    .finance-card { right: 0; top: 35px; width: 162px; padding: 16px 17px 14px; transform: rotate(7deg); animation-delay: -2.5s; }
    .bars { display: flex; align-items: end; gap: 7px; height: 43px; margin-top: 12px; }
    .bars i { flex: 1; display: block; border-radius: 3px 3px 1px 1px; background: #dce5f3; }
    .bars i:nth-child(1) { height: 34%; }.bars i:nth-child(2) { height: 56%; }.bars i:nth-child(3) { height: 44%; }.bars i:nth-child(4) { height: 70%; }.bars i:nth-child(5) { height: 63%; }.bars i:nth-child(6) { height: 91%; background: #8ca4c9; }
    .life-card { display: flex; align-items: center; gap: 8px; right: 33px; bottom: 22px; padding: 10px 14px; border-radius: 30px; font-size: 10px; color: #75849b; animation-delay: -4s; }
    .life-card .icon { color: #8ca194; width: 14px; height: 14px; }
    .story-footer { position: relative; display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-top: 24px; color: #8894a6; font-size: 10px; letter-spacing: .6px; }
    .footer-line { width: 42px; height: 1px; background: #c6d1e0; }
    .login-panel { display: flex; flex-direction: column; position: relative; min-width: 0; padding: 42px 48px 30px; }
    .panel-top { display: flex; justify-content: flex-end; align-items: center; gap: 7px; color: #8591a2; font-size: 11px; }
    .panel-top .icon { width: 13px; height: 13px; color: #7e93ad; }
    .login-content { width: 100%; max-width: 360px; margin: auto; padding: 36px 0; }
    .welcome-icon { display: grid; place-items: center; width: 47px; height: 47px; margin-bottom: 22px; color: #6c84ad; background: #f0f4fa; border: 1px solid #e8edf5; border-radius: 14px; }
    .welcome-icon .icon { width: 23px; height: 23px; }
    .welcome-label { margin: 0 0 12px; color: #8b97a9; font-size: 10px; font-weight: 550; letter-spacing: 2.5px; }
    h1 { margin: 0 0 14px; font-size: 31px; letter-spacing: -1px; font-weight: 600; line-height: 1.5; }
    .login-description { font-size: 13px; color: #65748a; line-height: 1.9; margin: 0; }
    .login-form { margin-top: 28px; }
    .form-field { margin-top: 20px; }
    .form-field:first-of-type { margin-top: 0; }
    .form-field label { display: block; margin-bottom: 9px; color: #4e5c72; font-size: 12px; font-weight: 550; }
    .input-wrap { position: relative; display: flex; align-items: center; }
    .input-wrap > .icon { position: absolute; left: 15px; width: 17px; height: 17px; color: #8e9bb0; pointer-events: none; }
    .input-wrap input { width: 100%; min-width: 0; height: 50px; padding: 12px 15px 12px 43px; border: 1px solid #dfe5ee; border-radius: 9px; background: #fbfcfe; color: #253148; font-size: 14px; transition: border-color .2s, box-shadow .2s; }
    .input-wrap input::placeholder { color: #919bab; font-size: 12px; }
    .input-wrap input:hover { border-color: #bac8dd; }
    .input-wrap input:focus { border-color: #6f8ab9; background: #fff; outline: 0; box-shadow: 0 0 0 3px #5574b512; }
    .form-caption { margin-top: 15px; display: flex; justify-content: space-between; gap: 8px; align-items: center; font-size: 10px; color: #6b788c; }
    .form-caption span { display: inline-flex; align-items: center; gap: 4px; }
    .form-caption .icon { width: 12px; height: 12px; color: #78958a; }
    .login-error { display: flex; align-items: center; gap: 8px; margin: 0 0 20px; padding: 11px 13px; background: #fff4f2; color: #a23c3c; border: 1px solid #f1d7d3; border-radius: 8px; font-size: 12px; line-height: 1.7; }
    .login-error .icon { width: 15px; height: 15px; }
    .sign-in { font-family: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 11px; width: 100%; min-height: 54px; margin-top: 22px; padding: 16px 18px; border: 1px solid #5574a8; border-radius: 10px; background: #5574a8; color: white; font-size: 13px; font-weight: 550; box-shadow: 0 5px 12px #5574a81a; transition: background .2s, transform .2s, box-shadow .2s; }
    .sign-in:hover { background: #466594; box-shadow: 0 7px 18px #5574a82b; transform: translateY(-1px); }
    .sign-in:active { transform: translateY(0); }
    .sign-in > .icon { width: 18px; height: 18px; }
    .sign-in .button-arrow { position: absolute; right: 19px; margin-left: 0; width: 17px; }
    .sign-in { position: relative; }
    .sign-in .button-label { letter-spacing: 3px; padding-left: 3px; }
    .auth-note { margin: 12px 0 0; font-size: 10px; color: #6b788c; text-align: center; line-height: 1.8; }
    .feature-divider { display: flex; align-items: center; gap: 15px; margin: 25px 0 20px; color: #6b788c; font-size: 10px; letter-spacing: 1px; }
    .feature-divider::before, .feature-divider::after { content: ""; flex: 1; height: 1px; background: #ecf0f5; }
    .features { display: flex; justify-content: space-around; gap: 12px; padding: 0 5px; }
    .feature { text-align: center; font-size: 10px; color: #65748a; }
    .feature .icon { display: block; margin: 0 auto 9px; width: 18px; height: 18px; color: #91a2bb; }
    .login-help { margin-top: 22px; padding-top: 20px; border-top: 1px solid #edf0f5; }
    .login-help summary { min-height: 36px; display: flex; align-items: center; justify-content: center; gap: 5px; width: fit-content; margin: auto; font-size: 11px; color: #65748a; cursor: pointer; list-style: none; }
    .login-help summary::-webkit-details-marker { display: none; }
    .login-help summary .icon { width: 12px; height: 12px; transition: transform .2s; }
    .login-help[open] summary .icon { transform: rotate(180deg); }
    .login-help p { margin: 14px 0 0; padding: 13px 15px; font-size: 11px; line-height: 1.9; color: #65748a; background: #f7f9fc; border-radius: 8px; }
    .panel-footer { display: flex; flex-direction: column; align-items: center; gap: 8px; color: #9aa3b0; font-size: 10px; line-height: 1.8; text-align: center; }
    .privacy-note { display: flex; align-items: center; gap: 5px; }
    .privacy-note .icon { width: 11px; height: 11px; }
    .mobile-brand { display: none; }
    @keyframes float { 0%, 100% { translate: 0 0; } 50% { translate: 0 -7px; } }
    @media (min-width: 1600px) { .story { padding-left: 12%; padding-right: 12%; }.story-content { padding-top: 85px; }.universe { height: 370px; margin-top: 30px; } }
    @media (max-width: 1100px) { .story { padding: 34px 8% 28px; }.login-panel { padding: 34px 36px 28px; }.story h2 { font-size: 44px; }.story-intro { font-size: 12px; }.universe { height: 300px; }.orbit { width: 230px; height: 230px; }.health-card { width: 158px; padding: 14px; left: -8px; }.finance-card { width: 142px; padding: 13px; right: -12px; }.life-card { right: 0; bottom: 12px; }.story-footer { font-size: 9px; } }
    @media (max-width: 760px) { .login-shell { grid-template-columns: 1fr; }.story { display: none; }.login-panel { min-height: 100svh; padding: max(28px, env(safe-area-inset-top)) 28px max(24px, env(safe-area-inset-bottom)); background: radial-gradient(ellipse at 90% 0%, #edf2f9 0%, transparent 45%), #fff; }.panel-top { justify-content: space-between; }.mobile-brand { display: inline-flex; }.mobile-brand .brand-logo { width: 32px; height: 32px; border-radius: 9px; }.mobile-brand .brand-name { font-size: 19px; }.panel-top > .icon { display: none; }.panel-top > span { font-size: 10px; }.login-content { max-width: 380px; padding: 36px 0; }.welcome-icon { margin-bottom: 26px; }h1 { font-size: 30px; }.login-description { font-size: 13px; }.input-wrap input { font-size: 16px; }.sign-in { min-height: 55px; }.panel-footer { padding-top: 12px; } }
    @media (max-width: 360px) { .login-panel { padding-left: 22px; padding-right: 22px; }.panel-top > span { font-size: 9px; }.login-content { padding: 28px 0; }h1 { font-size: 28px; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  </style>
</head>
<body>
  <main class="login-shell">
    <section class="story" aria-labelledby="story-heading">
      <div class="brand">${brandLogo}<span class="brand-name">Jiashu <span>OS</span></span></div>
      <div class="story-content">
        <div class="eyebrow">YOUR LIFE, IN BALANCE</div>
        <h2 id="story-heading">把生活，<br><span>慢慢理清。</span></h2>
        <p class="story-intro">关照身体的变化，记录生活的积累。<br>在一个安静的空间里，找到自己的节奏。</p>
        <div class="universe" aria-hidden="true">
          <div class="orbit"><i class="orbit-dot"></i><i class="orbit-dot second"></i></div>
          <div class="core">${brandLogo}</div>
          <div class="float-card health-card">
            <div class="card-top"><span class="card-icon">${icon('heart')}</span>健康有迹可循</div>
            <svg class="health-line" viewBox="0 0 145 38" fill="none"><path d="M0 31H145" stroke="#edf1f5"/><path d="M0 30C12 30 11 21 22 24S35 35 44 22 56 30 66 16 79 25 89 13 102 20 113 9 129 12 145 3" stroke="#8daa9b" stroke-width="2" stroke-linecap="round"/><circle cx="145" cy="3" r="3" fill="#8daa9b" stroke="white" stroke-width="2"/></svg>
            <div class="card-foot">步数 · 睡眠 · 身体状态</div>
          </div>
          <div class="float-card finance-card">
            <div class="card-top"><span class="card-icon">${icon('wallet')}</span>财务心中有数</div>
            <div class="bars"><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <div class="card-foot">记录积累，看见变化</div>
          </div>
          <div class="float-card life-card">${icon('leaf')}每一天，都更清晰一点</div>
        </div>
      </div>
      <footer class="story-footer"><span>为生活留白，为自己留心。</span><span class="footer-line"></span><span>EST. 2026</span></footer>
    </section>

    <section class="login-panel" aria-labelledby="login-heading">
      <header class="panel-top"><div class="brand mobile-brand">${brandLogo}<span class="brand-name">Jiashu <span>OS</span></span></div>${icon('lock')}<span>你的私人生活空间</span></header>
      <div class="login-content">
        <div class="welcome-icon">${icon('leaf')}</div>
        <p class="welcome-label">A LITTLE SPACE FOR YOU</p>
        <h1 id="login-heading">欢迎回来。</h1>
        <p class="login-description">登录你的账号，继续照顾生活的每一面。<br>从今天开始，多了解自己一点。</p>

        <form class="login-form" action="/signin-with-chatgpt" method="post">
          <input type="hidden" name="csrf" value="${escapeAttribute(csrf)}">
          <input type="hidden" name="return_to" value="${escapeAttribute(returnTo)}">
          ${error ? '<p class="login-error" id="login-error" role="alert">' + icon('lock') + '<span>' + escapeAttribute(error) + '</span></p>' : ''}
          <div class="form-field"><label for="login-email">邮箱地址</label><div class="input-wrap">${icon('mail')}<input id="login-email" type="email" name="email" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254" placeholder="you@example.com" required${error ? ' aria-describedby="login-error"' : ''}></div></div>
          <div class="form-field"><label for="login-password">密码</label><div class="input-wrap">${icon('lock')}<input id="login-password" name="password" type="password" autocomplete="current-password" maxlength="1024" placeholder="请输入你的密码" required${error ? ' aria-describedby="login-error"' : ''}></div></div>
          <div class="form-caption"><span>${icon('check')}安全登录你的专属空间</span><span>忘记密码？见下方说明</span></div>
          <button class="sign-in" type="submit"><span class="button-label">登录</span>${icon('arrow', 'button-arrow')}</button>
        </form>
        <p class="auth-note">使用管理员为你开通的邮箱和密码。</p>

        <div class="feature-divider">让生活更有条理</div>
        <div class="features" aria-label="Jiashu OS 的生活管理功能">
          <div class="feature">${icon('heart')}健康与趋势</div>
          <div class="feature">${icon('wallet')}财务与积累</div>
          <div class="feature">${icon('leaf')}生活与记录</div>
        </div>

        <details class="login-help" id="login-help"><summary>需要账号或忘记密码？${icon('chevron')}</summary><p>使用管理员为你开通的邮箱和密码登录，每个账号的生活记录独立保存。需要开通账号或重置密码，请联系网站管理员。</p></details>
      </div>
      <footer class="panel-footer"><span class="privacy-note">${icon('lock')}个人记录，随账号独立保存</span><span>© ${new Date().getUTCFullYear()} Jiashu OS · 慢慢来，生活会有答案。</span></footer>
    </section>
  </main>
</body>
</html>`;
}
