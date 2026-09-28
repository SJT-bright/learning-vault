#!/usr/bin/env node
/**
 * C 轮检查：继续使用工作台纯函数边界 + index.html 结构/回退风险静态断言
 * 用法：node scripts/round-c-check.js   （在项目根或 C 副本根运行）
 * 只读检查，不写库、不启动 Electron。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const wb = require('../src/reuse-workbench.js');

function main() {
  const root = path.resolve(__dirname, '..');
  if (!fs.existsSync(path.join(root, 'main', 'index.html'))) {
    console.error('找不到 main/index.html：请在项目根或 C 副本的 scripts/ 目录下运行');
    process.exitCode = 2;
    return;
  }

  const results = [];
  const check = (name, ok, detail) => results.push([name, !!ok, detail === undefined ? '' : String(detail)]);

  const DAY = 86400000;
  const NOW = new Date(2026, 8, 24, 12, 0, 0).getTime(); // 固定“现在”，结果可复现

  const mkItem = (over) => Object.assign({
    id: 'it1', title: '一条资料', kind: 'note', trashed: false,
    uses: [], improvements: [], versions: [], messages: [], created_at: NOW - 5 * DAY, updated_at: NOW - DAY,
  }, over);

  // ---------- 1. 零数据：四段全在、全部如实留空、不崩 ----------
  {
    const feed = wb.buildReuseFeed({ items: [], extracts: [], ideas: [], now: NOW });
    check('零数据不崩且返回 sections', Array.isArray(feed.sections) && feed.sections.length === 4, JSON.stringify(feed.sections.map(s => s.id)));
    check('零数据各段空 entries', feed.sections.every(s => Array.isArray(s.entries) && s.entries.length === 0));
    check('零数据各段有如实空态文案', feed.sections.every(s => typeof s.emptyText === 'string' && s.emptyText.length > 4));
    check('零数据角标为 0', wb.reuseBadgeCount(feed) === 0);
  }

  // ---------- 2. 最近实际使用：只认 uses、窗口、去重取最新、时间倒序 ----------
  {
    const items = [
      mkItem({ id: 'a', title: '旧用法', uses: [{ used_at: NOW - 20 * DAY, purpose: '窗口外' }] }),
      mkItem({ id: 'b', title: '两次使用', uses: [
        { used_at: NOW - 3 * DAY, purpose: '早的那次' },
        { used_at: NOW - 1 * DAY, purpose: '晚的那次', result: '好' },
      ] }),
      mkItem({ id: 'c', title: 'last_used_at 孤值（不算使用）', last_used_at: NOW - 2 * DAY }),
      mkItem({ id: 'd', title: 'trashed', uses: [{ used_at: NOW - 1 * DAY, purpose: 'x' }], trashed: true }),
    ];
    const feed = wb.buildReuseFeed({ items, extracts: [], ideas: [], now: NOW });
    const sec = feed.sections.find(s => s.id === 'recent-uses');
    check('窗口外/无 uses/已删除都不出现', sec.entries.length === 1 && sec.entries[0].itemId === 'b', JSON.stringify(sec.entries));
    const e = sec.entries[0];
    check('去重保留最新一次使用', e.reason.includes('9月23日') && e.reason.includes('晚的那次'), e.reason);
    check('每条带 reason 与唯一 action', e.action && e.action.id === 'record-use' && e.action.label.length > 0);
    check('打开详情没有被当成使用（c 不在列表）', !sec.entries.some(x => x.itemId === 'c'));
  }

  // ---------- 3. 改进待验证：窗口内未验证才出现，验证后消失 ----------
  {
    const items = [
      mkItem({ id: 'p', improvements: [{ id: 'i1', created_at: NOW - 2 * DAY, problem: '开头太平', version_id: 'v2' }] }),
      mkItem({ id: 'q', improvements: [{ id: 'i2', created_at: NOW - 2 * DAY, problem: '已再用过' }],
        uses: [{ used_at: NOW - 1 * DAY, purpose: '验证过' }] }),
      mkItem({ id: 'r', improvements: [{ id: 'i3', created_at: NOW - 40 * DAY, problem: '窗口外' }] }),
    ];
    const feed = wb.buildReuseFeed({ items, now: NOW });
    const sec = feed.sections.find(s => s.id === 'improve-pending');
    check('只有未验证且在窗口内的改进出现', sec.entries.length === 1 && sec.entries[0].itemId === 'p', JSON.stringify(sec.entries));
    check('reason 说明为什么在（改进待验证）', sec.entries[0].reason.includes('改进待验证'));
    check('角标计入待验证改进', wb.reuseBadgeCount(feed) === 1, wb.reuseBadgeCount(feed));
    check('improvementVerified 纯函数判断', wb.improvementVerified(items[1], items[1].improvements[0]) === true
      && wb.improvementVerified(items[0], items[0].improvements[0]) === false);
  }

  // ---------- 4. 本周点子关联：related_item_ids 命中、done/parked 排除、悬空引用跳过 ----------
  {
    const items = [mkItem({ id: 'm1', title: '被点子引用的资料' }), mkItem({ id: 'm2' })];
    const ideas = [
      { id: 'idea1', text: '试着做一期视频', status: 'try', related_item_ids: ['m1', 'ghost'] },
      { id: 'idea2', text: '已放弃', status: 'parked', related_item_ids: ['m2'] },
      { id: 'idea3', text: '已完成', status: 'done', related_item_ids: ['m2'] },
    ];
    const feed = wb.buildReuseFeed({ items, ideas, now: NOW });
    const sec = feed.sections.find(s => s.id === 'idea-linked');
    check('点子关联资料出现且带点子文案', sec.entries.length === 1 && sec.entries[0].itemId === 'm1' && sec.entries[0].reason.includes('试着做一期视频'), JSON.stringify(sec.entries));
    check('done/parked 点子与悬空 id 都被排除', !sec.entries.some(x => x.itemId === 'm2' || x.itemId === 'ghost'));
  }

  // ---------- 5. 待处理项：附件待补 / 登录墙 / 来源已删 ----------
  {
    const items = [
      mkItem({ id: 'chat1', kind: 'chat', updated_at: NOW - 3600e3, messages: [
        { id: 'g1', attachment: { pending: true, name: '方案.pdf' } },
        { id: 'g2', attachment: { pending: true, name: '表格.xlsx' } },
        { id: 'g3', attachment: { path: '/tmp/x', name: '齐了' } },
      ] }),
      mkItem({ id: 'wall1', login_wall: true, updated_at: NOW - 7200e3 }),
    ];
    const extracts = [{ id: 'e1', title: '孤儿整理', source_item_id: 'deleted-item' }, { id: 'e2', title: '有来源', source_item_id: 'chat1' }];
    const feed = wb.buildReuseFeed({ items, extracts, now: NOW });
    const sec = feed.sections.find(s => s.id === 'needs-fix');
    check('待补附件计数正确', sec.entries.some(x => x.id === 'nf-att:chat1' && x.reason.includes('2 条')), JSON.stringify(sec.entries));
    check('登录墙资料出现', sec.entries.some(x => x.id === 'nf-wall:wall1'));
    check('来源已删的整理出现', sec.entries.some(x => x.id === 'nf-src:e1'));
    check('有来源的整理不误报', !sec.entries.some(x => x.id === 'nf-src:e2'));
    check('待处理按更新时间倒序（附件在前）', sec.entries[0].id === 'nf-att:chat1', sec.entries[0].id);
    check('角标计入待处理项', wb.reuseBadgeCount(feed) >= 3, wb.reuseBadgeCount(feed));
  }

  // ---------- 6. 上限与溢出：每段截断 + overflow 计数，不做排行榜 ----------
  {
    const items = [];
    for (let i = 0; i < 9; i++) items.push(mkItem({ id: 'u' + i, uses: [{ used_at: NOW - (i + 1) * 3600e3, purpose: '第' + i }] }));
    const feed = wb.buildReuseFeed({ items, now: NOW, options: { limitPerSection: 5 } });
    const sec = feed.sections.find(s => s.id === 'recent-uses');
    check('每段上限 5 条', sec.entries.length === 5);
    check('溢出如实标注（不悄悄丢弃）', sec.overflow === 4, sec.overflow);
    check('按时间倒序（最新的在前）', sec.entries[0].itemId === 'u0' && sec.entries[4].itemId === 'u4');
    check('无分数/排名字段（不做装饰分数）', sec.entries.every(e => !('score' in e) && !('rank' in e) && !('percent' in e)));
  }

  // ---------- 7. 长标题与怪输入 ----------
  {
    const longTitle = '这是一个非常非常非常非常非常非常非常非常非常非常非常长的标题'.repeat(4);
    const items = [mkItem({ id: 'L', title: longTitle, uses: [{ used_at: NOW - DAY, purpose: 'x'.repeat(80) }] })];
    const feed = wb.buildReuseFeed({ items, now: NOW });
    const t = feed.sections.find(s => s.id === 'recent-uses').entries[0].title;
    check('长标题被截断且带省略号', t.length <= 44 && t.endsWith('…'), t);
    const messy = wb.buildReuseFeed({ items: [null, undefined, mkItem({ uses: [null, {}] })], extracts: [null], ideas: [null], now: NOW });
    check('null/缺字段条目不崩', Array.isArray(messy.sections));
    check('缺 now 时默认 Date.now() 可用', Array.isArray(wb.buildReuseFeed({ items: [] }).sections));
  }

  // ---------- 8. 确定性 + 纯度（不改输入） ----------
  {
    const items = [mkItem({ id: 'x', uses: [{ used_at: NOW - DAY, purpose: 'a' }], improvements: [{ id: 'i', created_at: NOW - DAY, problem: 'p' }] })];
    const extracts = [{ id: 'e', source_item_id: 'gone' }];
    const ideas = [{ id: 'd', text: 't', status: 'try', related_item_ids: ['x'] }];
    const before = JSON.stringify({ items, extracts, ideas });
    const f1 = wb.buildReuseFeed({ items, extracts, ideas, now: NOW });
    const f2 = wb.buildReuseFeed({ items, extracts, ideas, now: NOW });
    check('同输入同输出（确定性）', JSON.stringify(f1) === JSON.stringify(f2));
    check('输入对象未被修改（纯函数）', JSON.stringify({ items, extracts, ideas }) === before);
  }

  // ---------- 9. index.html 结构断言：分组导航 / P0 P1 保留 / 设置迁移 / 键盘 ----------
  {
    const html = fs.readFileSync(path.join(root, 'main', 'index.html'), 'utf8');
    // 9a 动作分组导航
    for (const g of ['收进来', '找资料', '拿来用 · 推进', '回 看']) check(`侧栏分组「${g}」存在`, html.includes(`>${g}<`));
    check('继续使用入口存在', html.includes('data-view="reuse"') && html.includes('id="reuseCount"'));
    check('继续使用是唯一新增视图（未并列重复导航）', (html.match(/class="nav" data-view="reuse"/g) || []).length === 1);
    // 9b 既有入口一个不丢
    for (const id of ['srsBtn', 'resurfaceCount', 'ideaBtn', 'ideaCount', 'ingestBtn', 'scanVideoBtn',
      'taxonomyBtn', 'organizeBtn', 'reviewBtn', 'settingsBtn', 'catAddBtn', 'search', 'addBtn']) {
      check(`既有入口 id 保留：${id}`, html.includes(`id="${id}"`));
    }
    for (const v of ['"all"', '"favorites"', '"today"', '"week"', '"quotes"', '"used"', '"frequent"', '"extracts"']) {
      check(`既有视图入口保留：${v}`, html.includes(`data-view=${v}`));
    }
    // 9c P0/P1 回看与复习链路保留
    check('P0 该回看了视图分支保留', html.includes('resurfaceToday()'));
    check('P0 回看动作（打开/贪睡/不再）保留', html.includes('resurfaceSnooze') && html.includes('resurfaceDismiss') && html.includes('data-rs="snooze"'));
    check('P0 通知直达 onNavigate 保留', html.includes('onNavigate'));
    check('P1 复习护栏 srsGuard 保留', html.includes('srsGuard'));
    check('P1 加入复习弹窗（AI 预取）保留', html.includes('srsAiDraft'));
    // 9d 工作台渲染与纯函数接入
    check('index.html 引入 reuse-workbench.js', html.includes('../src/reuse-workbench.js'));
    check('工作台渲染函数存在', html.includes('renderReuseView') && html.includes('buildReuseFeed'));
    check('「打开不算使用」口径写进界面', html.includes('打开不算'));
    check('每条工作台条目展示出现理由', html.includes('为什么在这里'));
    // 9e 详情页边界与动线
    for (const id of ['bodyLabel', 'verTag', 'origToggle', 'origBox', 'copyText', 'copyVerBtn', 'useBtn', 'improveBtn', 'extractBtn', 'aiExtractBtn', 'linkIdeaBtn']) {
      check(`详情页元素保留/新增：${id}`, html.includes(`id="${id}"`));
    }
    check('复制当前版本与展示同源（用 current_version 内容）', html.includes('curVer.content != null) ? curVer.content : it.text'));
    check('动作分组（拿来用/整理·推进/改进/维护）', html.includes('dact-label">拿来用') && html.includes('dact-label">改进'));
    // 9f 设置页迁移
    check('便携导出按钮存在', html.includes('peExportBtn'));
    check('便携恢复预检→确认两段式', html.includes('portablePreview') && html.includes('portableRestore') && html.includes('confirmRestore'));
    check('D 接口未接入时如实提示（不假装成功）', html.includes("portableExport !== 'function'"));
    check('旧 JSON 入口保留且标注只含记录和路径', html.includes('jsonExportBtn') && html.includes('只含记录和附件路径'));
    check('旧 JSON 导入入口保留', html.includes('jsonImportBtn') && html.includes('importJson'));
    check('不请求凭据（无新增密钥字段）', !html.includes('data-k="secret"') && !html.includes('askCredentials'));
    // 9g 键盘
    check('⌘1~6 含继续使用', html.includes("'quotes', 'reuse'"));
    check('速查卡包含 ⌘1~5 与 ⌘6 两行', html.includes('⌘1~5') && html.includes("'⌘6'"));
    // 9h reuseMode 守卫
    check('金句/继续使用互斥', html.includes('if (reuseMode) exitReuseMode();'));
    check('多选在继续使用视图被拦截', html.includes('if (quoteMode || reuseMode)'));
    check('回车打开原文在继续使用视图被拦截', html.includes('!quoteMode && !reuseMode'));
    // 9i C-QA-SEARCH-02：搜索点击竞态守卫
    check('refresh 代序守卫：过期查询结果不渲染', html.includes('if (seq !== refreshSeq) return;'));
    check('刷新尾部不覆盖用户点击后的选择（pickedAt === pickSeq）', html.includes('pickedAt === pickSeq'));
    check('用户选卡计入 pickSeq（列表卡与回看打开）', (html.match(/pickSeq\+\+/g) || []).length >= 2);
    check('搜索清空基准取 input 时刻快照（防抖窗内点击/输入后切视图受保护）', html.includes('inputGuard = { pick: pickSeq, nav: navSeq }') && html.includes('refresh(false, false, inputGuard)'));
    check('视图切换代序守卫：旧刷新不清掉新视图内容（navSeq）', html.includes('navAtStart === navSeq') && (html.match(/navSeq\+\+/g) || []).length >= 3);
    // 9j C-QA-SEARCH-03：过期刷新在写共享状态/左栏前即被拒
    check('视图切换使挂起刷新整体失效（refreshSeq++ 在 setView/enterReuseMode/enterQuoteMode）', (html.match(/refreshSeq\+\+/g) || []).length >= 3);
    check('防抖回调排除 reuseMode（旧计时器不得接管工作台）', html.includes('!quoteMode && !reuseMode) refresh'));
    check('facets 在代序守卫通过后才提交（facetsNext）', html.includes('let facetsNext = facets;') && html.includes('facets = facetsNext;') && !/^\s*facets = (full|r)\.facets;/m.test(html));
  }

  // ---------- 10. 双端加载（Node require + 浏览器 window） ----------
  {
    const src = fs.readFileSync(path.join(root, 'src', 'reuse-workbench.js'), 'utf8');
    check('模块可被 Node require（module.exports）', src.includes('module.exports') && typeof wb.buildReuseFeed === 'function');
    check('模块可被浏览器 script 标签加载（window.ReuseWorkbench）', src.includes('window.ReuseWorkbench'));
    check('模块零依赖（不 require 其他文件，浏览器可独立加载）', !/require\(/.test(src));
  }

  // ---------- 汇总 ----------
  let pass = 0;
  for (const [name, ok, detail] of results) {
    console.log((ok ? '✓ ' : '✗ FAIL: ') + name + (ok || !detail ? '' : ' — ' + detail));
    if (ok) pass++;
  }
  console.log(`ROUND_C_CHECK ${pass}/${results.length}`);
  process.exitCode = pass === results.length ? 0 : 1;
}

main();
