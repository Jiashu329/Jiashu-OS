import type { Metadata } from 'next';
import { APP_BRAND_ASSETS } from '../lib/branding';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jiashu OS · 人生管理',
  description: '私人健康数据与个人、家庭财务账本。',
  applicationName: 'Jiashu OS',
  icons: {
    icon: [
      { url: APP_BRAND_ASSETS.favicon, type: 'image/x-icon' },
      { url: APP_BRAND_ASSETS.faviconPng, type: 'image/png', sizes: '32x32' },
    ],
    apple: [{ url: APP_BRAND_ASSETS.appleTouchIcon, sizes: '180x180' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Jiashu OS',
    statusBarStyle: 'default',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="manifest" href={APP_BRAND_ASSETS.manifest} crossOrigin="use-credentials" />
      </head>
      <body>{children}</body>
    </html>
  );
}
