// ==UserScript==
// @name         耗材管家 · MakerWorld 导入助手
// @namespace    http://127.0.0.1:4173/
// @version      0.1.0
// @description  在 MakerWorld 模型页把页面数据发送到本地「耗材管家」，绕过 Cloudflare 对服务器的拦截
// @match        https://makerworld.com/*
// @match        https://www.makerworld.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// 安装：装好 Tampermonkey → 新建脚本 → 粘贴本文件 → 保存。
// 用法：打开 MakerWorld 模型页 → 右下角点「导入耗材管家」→ 浏览器会新开本地页面并自动载入模型。
// 说明：只在你点击时读取当前页面已渲染的数据（标题/封面/__NEXT_DATA__），不做自动爬取。

(function () {
  'use strict';

  const APP = 'http://127.0.0.1:4173';

  const btn = document.createElement('button');
  btn.textContent = '🧵 导入耗材管家';
  Object.assign(btn.style, {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    zIndex: 999999,
    padding: '10px 16px',
    borderRadius: '999px',
    border: '0',
    background: '#0f766e',
    color: '#fff',
    font: '600 14px/1.2 "PingFang SC", "Microsoft YaHei", sans-serif',
    boxShadow: '0 8px 24px -8px rgba(0,0,0,.45)',
    cursor: 'pointer',
  });

  function setText(text, background) {
    btn.textContent = text;
    if (background) btn.style.background = background;
  }

  btn.addEventListener('click', async () => {
    setText('正在导入…', '#334155');
    try {
      const nextData = document.querySelector('#__NEXT_DATA__')?.textContent || '';
      const html = nextData
        ? `<script id="__NEXT_DATA__" type="application/json">${nextData.replace(/<\/script>/gi, '<\\/script>')}</script>`
        : document.documentElement.outerHTML.slice(0, 4 * 1024 * 1024);
      const cover =
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
      const payload = {
        url: location.href,
        title: (document.title || '').replace(/\s*[-|]\s*MakerWorld.*$/i, '').trim(),
        cover,
        html,
      };

      const res = await fetch(`${APP}/api/import/page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);

      const hasReqs = (data.requirements || []).length > 0;
      setText(hasReqs ? `已导入 ${data.requirements.length} 项材料 ✓` : '已导入模型，需手动补材料', hasReqs ? '#15803d' : '#b45309');
      if (data.importId) {
        window.open(`${APP}/#import=${data.importId}`, '_blank');
      }
      setTimeout(() => {
        setText('🧵 导入耗材管家', '#0f766e');
      }, 4000);
    } catch (err) {
      console.error('[耗材管家] 导入失败', err);
      setText('导入失败：请确认本地服务已启动', '#b91c1c');
      setTimeout(() => {
        setText('🧵 导入耗材管家', '#0f766e');
      }, 5000);
    }
  });

  function mount() {
    if (!document.body.contains(btn)) document.body.appendChild(btn);
  }

  mount();
  // MakerWorld 是单页应用，路由变化时确保按钮还在
  setInterval(mount, 2000);
})();
