/**
 * 每晚职责窗口与补跑判定（P0，纯函数零依赖；now 一律参数注入，selfcheck 可直测）
 *
 * 窗口：[target, target+30)（本地墙钟分钟）
 * 补跑（catch-up）：错过窗口后的恢复路径。同日防重由 config.lastCatchUp 记账（调用方负责）。
 *   A) 窗口已过（now ≥ target+30）且今天还没生成日报 → 补
 *   B) lastDailyReview 落后 ≥2 天（跨天睡眠/关机，昨天也错过）→ 随时可补
 *   窗口内不触发补跑（窗口内的正常每分钟 tick 会执行职责）
 */
const DAY_MS = 86400000;

function dayKeyOf(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// 'HH:mm' → 当日分钟数；非法/缺省回退 21:30
function parseTarget(autoReviewTime, fallback = '21:30') {
  const src = String(autoReviewTime || '').trim() || fallback;
  const [h, m] = src.split(':').map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 21) * 60 + (Number.isFinite(m) ? m : 30);
}

function minutesOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }

// 窗口判定：[target, target+30)
function inWindow(now, target) {
  const cur = minutesOfDay(now);
  return cur >= target && cur < target + 30;
}

// 补跑判定（纯函数）
function shouldCatchUp(c, now, target) {
  const cc = c || {};
  if ((cc.lastCatchUp || '') === dayKeyOf(now)) return false; // 同一天最多补跑一次
  if (cc.autoReview === false) return false;
  if (inWindow(now, target)) return false; // 窗口内由正常 tick 负责
  const dk = dayKeyOf(now);
  // A) 窗口已过且今天还没跑
  if (minutesOfDay(now) >= target + 30 && cc.lastDailyReview !== dk) return true;
  // B) lastDailyReview 落后 ≥2 天（以正午锚点比较，避免毫秒级边界抖动）
  if (cc.lastDailyReview) {
    const last = new Date(cc.lastDailyReview + 'T12:00:00');
    if (!isNaN(last.getTime())) {
      const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
      if (todayNoon - last.getTime() >= 2 * DAY_MS) return true;
    }
  }
  return false;
}

module.exports = { DAY_MS, dayKeyOf, parseTarget, minutesOfDay, inWindow, shouldCatchUp };
