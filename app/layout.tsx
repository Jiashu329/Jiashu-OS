import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jiashu OS · 健康',
  description: '私人健康状态与趋势，连接苹果健康中的步数、睡眠和活动能量。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
