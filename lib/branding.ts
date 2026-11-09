export const APP_BRAND_ASSETS = {
  logo: '/brand/logo-192.png?v=brand1',
  favicon: '/favicon.ico?v=brand1',
  faviconPng: '/brand/favicon-32.png?v=brand1',
  appleTouchIcon: '/apple-touch-icon.png?v=brand1',
  manifest: '/manifest.webmanifest?v=brand1',
} as const;

export const APP_LOGO_SRC = APP_BRAND_ASSETS.logo;

// Raw HTML routes do not inherit Next's layout metadata.
export const APP_BRAND_HEAD = String.raw`<link rel="icon" href="${APP_BRAND_ASSETS.favicon}" type="image/x-icon">
<link rel="icon" href="${APP_BRAND_ASSETS.faviconPng}" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="${APP_BRAND_ASSETS.appleTouchIcon}" sizes="180x180">
<link rel="manifest" href="${APP_BRAND_ASSETS.manifest}" crossorigin="use-credentials">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Jiashu OS">
<meta name="apple-mobile-web-app-status-bar-style" content="default">`;
