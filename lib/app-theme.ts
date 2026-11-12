/** Shared palette for the calm, blue-gray personal workspace. */
export const APP_THEME_CSS = String.raw`
:root{
  color-scheme:light;
  --bg:#f3f5f8;
  --paper:#fff;
  --ink:#1d2738;
  --muted:#606e84;
  --line:#dfe5ee;
  --primary:#5574b5;
  --primary-hover:#45639f;
  --soft:#e8effb;
  --green:var(--primary);
  --hover:#f0f4fa;
  --focus:#5574b5;
  --subtle:#f8fafd;
  --red:#a33131;
  --orange:#a16c3c;
  --radius:8px;
  --panel-radius:12px;
  --control-radius:8px;
  --shadow:0 2px 8px rgb(29 39 56 / 4%);
}
html{accent-color:var(--primary);text-rendering:optimizeLegibility;-webkit-text-size-adjust:100%}
body{font-variant-numeric:tabular-nums}
button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
::selection{background:#dbe6fa;color:var(--ink)}
`;
