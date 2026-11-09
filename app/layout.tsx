import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jiashu OS · 人生管理',
  description: '私人健康数据与个人、家庭财务账本。',
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
