/**
 * 悬浮条贴边几何（纯函数模块：零依赖、不 require electron，便于单测与主进程复用）
 *
 * 坐标口径：Electron 全局 DIP 坐标。多显示器下工作区 wa（workArea）的 x/y 不一定是 0，
 * 所有夹取/贴边判定都以调用方传入的 wa = { x, y, width, height } 为基准，
 * 本模块不做任何屏幕查询，也不持有窗口引用。
 */

// 磁吸阈值：窗口边缘距工作区左/右缘小于该像素时，松手自动吸附齐平
const SNAP_PX = 24;

/**
 * 把窗口左上角 pos 夹回工作区内（考虑窗口自身宽高 w/h）
 * @param {{x:number, y:number}} pos 窗口左上角
 * @param {{x:number, y:number, width:number, height:number}} wa 工作区
 * @returns {{x:number, y:number}} 新对象，不改入参
 */
function clampPos(pos, wa, w, h) {
  return {
    x: Math.round(Math.min(Math.max(pos.x, wa.x), wa.x + wa.width - w)),
    y: Math.round(Math.min(Math.max(pos.y, wa.y), wa.y + wa.height - h)),
  };
}

/**
 * 竖直夹取（80×80 圆钮专用）：横坐标由调用方固定贴工作区右缘，这里只把
 * 高度 y 夹回工作区内（考虑窗口自身高 h），返回取整后的数值。
 * @param {number} y 窗口左上角 y
 * @param {{x:number, y:number, width:number, height:number}} wa 工作区
 * @returns {number} 夹取后的 y
 */
function clampY(y, wa, h) {
  return Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - h));
}

/**
 * 判定贴边模式：
 * - 窗口右缘与工作区右缘齐平（1px 容差）→ 'dock-right'
 * - 窗口左缘与工作区左缘齐平 → 'dock-left'
 * - 其余 → 'float'
 * @returns {'dock-right'|'dock-left'|'float'}
 */
function edgeMode(pos, wa, w, h) {
  if (Math.abs((pos.x + w) - (wa.x + wa.width)) <= 1) return 'dock-right';
  if (Math.abs(pos.x - wa.x) <= 1) return 'dock-left';
  return 'float';
}

/**
 * 磁吸落点：窗口右缘/左缘距工作区对应边缘小于 SNAP_PX 时吸附为齐平，
 * 都不满足则原样返回。y 永远不动（竖直位置完全由用户拖放决定）。
 * @param {{x:number, y:number}} pos 窗口左上角
 * @param {{x:number, y:number, width:number, height:number}} wa 工作区
 * @returns {{x:number, y:number}} 新对象，不改入参
 */
function snapPos(pos, wa, w, h) {
  const distRight = Math.abs((pos.x + w) - (wa.x + wa.width)); // 右缘离工作区右缘
  const distLeft = Math.abs(pos.x - wa.x);                     // 左缘离工作区左缘
  if (distRight < SNAP_PX) return { x: wa.x + wa.width - w, y: pos.y };
  if (distLeft < SNAP_PX) return { x: wa.x, y: pos.y };
  return { x: pos.x, y: pos.y };
}

module.exports = { SNAP_PX, clampPos, edgeMode, snapPos, clampY };
