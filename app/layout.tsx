import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = {
  title: 'maimai Lab · 本地成绩工作台',
  description: '查询谱面、导入 maimai DX NET 成绩、计算 B50 和潜在涨分。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
