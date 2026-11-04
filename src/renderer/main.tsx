import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp, theme } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { TerminalApp } from './App';
import 'antd/dist/reset.css';
import 'react-querybuilder/dist/query-builder.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode>
  <ConfigProvider locale={ruRU} theme={{ algorithm: [theme.darkAlgorithm, theme.compactAlgorithm], token: {
    colorPrimary: '#f7a600', colorBgBase: '#101014', colorBgContainer: '#17181e', colorBorder: '#2b2d35',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", fontSize: 13, borderRadius: 6,
  } }}><AntApp><TerminalApp /></AntApp></ConfigProvider>
</React.StrictMode>);
