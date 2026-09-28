/**
 * 网页 / 飞书文档抓取 + HTML 转文本
 *
 * 飞书适配（v0.5）：
 * - parseLarkUrl 重写：任意子域（xxx.feishu.cn / xxx.larkoffice.com / *.larksuite.com /
 *   feishu.boe 等）按「后缀匹配」判定，覆盖 docx/doc/wiki/sheets/base/file/notes/
 *   minutes/minds/posts/share 全部链接形态，token 宽长校验
 * - 飞书正文是客户端渲染 + 常见登录墙：抓到的是壳页面时识别并标注 loginWall，
 *   标题照常提取（分享文档的 <title>/og:title 通常带文档名），正文空缺由附言补位
 * - 标题清洗：去掉「- 飞书云文档」「｜Feishu」等平台尾巴，让卡片标题就是文档名
 */
const { net } = require('electron');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 飞书/Lark 全后缀（含海外 larksuite、pixyu/larkoffice、ZZ BOE 域）
const LARK_SUFFIXES = ['feishu.cn', 'larksuite.com', 'larkoffice.com', 'feishu.boe', 'larkoffice.cn', 'feishu.net'];
// 文档/知识库等对象类型 → path 第一段
const LARK_TYPES = 'docx|doc|sheets|bitable|base|wiki|file|notes|minutes|minds|posts|share|drive';

function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

function isLarkHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return LARK_SUFFIXES.some(sfx => h === sfx || h.endsWith('.' + sfx));
}

function parseLarkUrl(u) {
  try {
    const url = new URL(u);
    if (!isLarkHost(url.hostname)) return null;
    const m = url.pathname.match(new RegExp('/(' + LARK_TYPES + ')/([A-Za-z0-9]{8,80})'));
    if (!m) return { type: 'other', token: '', host: url.hostname };
    let token = m[2];
    try { token = decodeURIComponent(token); } catch {}
    return { type: m[1], token: token.slice(0, 80), host: url.hostname };
  } catch { return null; }
}

// 飞书标题尾巴清洗：「文档名 - 飞书云文档」「文档名 ｜ 飞书」「doc - Feishu Docs」
function cleanLarkTitle(t) {
  return String(t || '')
    .replace(/\s*[-–—|｜·]\s*(飞书云文档|飞书文档|飞书|Lark Cloud Docs?|Feishu Docs?|Lark Docs?)\s*$/i, '')
    .replace(/\s*[-–—|｜]\s*[^\s|｜]{0,24}(云文档|知识库)\s*$/, '')
    .trim();
}

// 登录墙/壳页面识别：正文几乎为空 + 出现登录引导词
function looksLikeLoginWall(html, text) {
  if (text && text.length > 200) return false;
  const h = String(html || '');
  return /(请登录|扫码登录|登录后查看|立即登录|log\s?in\s+to\s+(view|continue)|sign\s+in\s+to\s+view)/i.test(h);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u3000]+/g, ' ').replace(/\n\s*\n\s*/g, '\n').trim();
  return s;
}

function titleFromHtml(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120);
  const og = String(html || '').match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
  if (og) return decodeEntities(og[1]).slice(0, 120);
  return '';
}

async function extractFromUrl(url) {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', Accept: 'text/html,*/*' },
    redirect: 'follow',
  });
  const finalUrl = res.url || url;
  const html = await res.text();
  const lark = parseLarkUrl(finalUrl);
  let title = titleFromHtml(html);
  if (lark) title = cleanLarkTitle(title);
  if (!title && lark) title = `飞书${lark.type} · ${lark.token || '文档'}`;
  if (!title) title = hostOf(finalUrl) || '网页';
  const raw = htmlToText(html);
  const loginWall = !!lark && looksLikeLoginWall(html, raw);
  const text = loginWall ? '' : raw.slice(0, 120000);
  return { title, text, site: hostOf(finalUrl), finalUrl, html, lark, loginWall };
}

module.exports = { extractFromUrl, htmlToText, parseLarkUrl, isLarkHost, cleanLarkTitle, looksLikeLoginWall, hostOf, titleFromHtml };
