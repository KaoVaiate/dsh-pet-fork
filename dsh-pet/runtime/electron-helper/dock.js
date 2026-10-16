/**
 * dsh-pet desktop helper —— 监控底座（PetDock）。
 *
 * 宠物脚下的毛玻璃胶囊底座：任务管理器式五项实时监控
 * CPU / 内存 / 磁盘 / 网络 / GPU（数据来自主进程 pet:metrics，2s 一拍广播）。
 *
 * 几何（与 sprite.js 同一套 CSS 像素，尺寸随 --pet-size 等比）：
 *   - 底座挂在 .pet-sprite 内、宠物脚底稍上（像踩在软垫上），宽 0.68×size；
 *   - 宠物贴地时 sprite 只有 winH 以内在屏幕内（窗口底部外扩余量伸出屏幕），
 *     底座会探出 sprite 底边 → groundLift = 探出量；sprite.sendBounds 据此把窗口
 *     整体上抬 groundLift、窗口高度补 groundLift，保证贴地时底座完整可见；
 *   - 底座关闭时 groundLift = 0，窗口上报几何与无底座时逐位一致（开关零回归）。
 *
 * 交互（底座是窗口内除身体命中区外唯一可交互的区域）：
 *   - sprite.onMouseMove 用 hitTest() 把「光标在底座上」并入可交互翻转；
 *   - sprite.syncInputRegions 把底座矩形报给主进程兜底通道（底座之外仍穿透到下层应用）；
 *   - 点击底座 → pet:open-taskmgr 打开系统任务管理器。
 *
 * 配图（图片素材）：碎碎念/对话带配图时，底座左侧额外显示一张缩略图（与头顶气泡同源，
 * 走 shared 的 createMemeImage + /pic/memes 素材链）；气泡收起即同步收起（该判定由 renderBubble 驱动）。
 *
 * 开关：右键菜单「显示/隐藏监控底座」，偏好存 localStorage（默认开）。
 */
'use strict';

(function () {
  const STORAGE_KEY = 'dsh-pet-dock-on';
  /** 网络速率条满刻度 = 100 Mbps（12.5 MB/s）；低于它按对数刻度映射，小流量也看得见动 */
  const NET_FULL_BPS = 12.5 * 1024 * 1024;
  const HOT_PCT = 70;
  const CRIT_PCT = 90;

  const CELLS = [
    { k: 'cpu', label: 'CPU' },
    { k: 'mem', label: '内存' },
    { k: 'disk', label: '磁盘' },
    { k: 'net', label: '网络' },
    { k: 'gpu', label: 'GPU' },
  ];

  const DOCK_CSS = `
.pet-dock{
  position:absolute; z-index:2;
  left:calc((var(--pet-size) - var(--dock-w))/2);
  top:var(--dock-top);
  width:var(--dock-w); height:var(--dock-h);
  display:flex; align-items:stretch;
  padding:calc(var(--pet-size)*.008) calc(var(--pet-size)*.01);
  border-radius:calc(var(--dock-h)/2);
  background:rgba(22,25,35,.62);
  -webkit-backdrop-filter:blur(20px) saturate(1.5);
  backdrop-filter:blur(20px) saturate(1.5);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 calc(var(--pet-size)*.012) calc(var(--pet-size)*.045) rgba(0,0,0,.30),
             inset 0 1px 0 rgba(255,255,255,.16);
  pointer-events:auto; cursor:pointer; overflow:hidden;
  transition:background-color .2s ease;
}
.pet-dock.is-off{display:none}
.pet-dock:hover{background:rgba(30,34,48,.80)}
.dock-cell{
  flex:1 1 0; min-width:0; position:relative;
  display:flex; flex-direction:column; justify-content:center;
  gap:calc(var(--pet-size)*.006);
  padding:0 calc(var(--pet-size)*.012);
}
.dock-cell + .dock-cell::before{
  content:''; position:absolute; left:0; top:24%; bottom:24%;
  width:1px; background:rgba(255,255,255,.10);
}
.dc-line{
  display:flex; align-items:baseline; justify-content:space-between;
  gap:calc(var(--pet-size)*.006); min-width:0;
}
.dc-label{
  font-size:calc(var(--pet-size)*.019);
  color:rgba(228,235,255,.55);
  line-height:1; letter-spacing:.02em; white-space:nowrap;
}
.dc-value{
  font-size:calc(var(--pet-size)*.0275);
  font-weight:700; color:#fff; line-height:1;
  font-variant-numeric:tabular-nums; white-space:nowrap;
}
.dc-bar{
  height:calc(var(--pet-size)*.006); min-height:2px;
  border-radius:99px; background:rgba(255,255,255,.14); overflow:hidden;
}
.dc-bar i{
  display:block; height:100%; width:0; border-radius:99px;
  background:#0a84ff;
  transition:width .5s cubic-bezier(.22,.8,.36,1);
}
.dock-cell.is-hot .dc-bar i{background:#ff9f0a}
.dock-cell.is-crit .dc-bar i{background:#ff453a}
.dock-cell.is-crit .dc-value{color:#ff8a85}
/* 配图区（图片素材）：碎碎念/对话带配图时，底座左侧一张缩略图，与指标并列 */
.pet-dock-img{
  flex:0 0 auto; display:none; overflow:hidden;
  width:calc(var(--dock-h) - var(--pet-size)*.02);
  margin-right:calc(var(--pet-size)*.008);
  border-radius:calc(var(--pet-size)*.018);
  background:rgba(255,255,255,.10);
}
.pet-dock-img.is-on{display:block}
.pet-dock-img .pet-bub-img{
  display:block; width:100%; height:100%; min-width:0; margin:0;
  border-radius:inherit; object-fit:cover;
}
@media (prefers-reduced-motion: reduce){
  .dc-bar i{transition:none}
}
`;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement('style');
    style.textContent = DOCK_CSS;
    document.head.appendChild(style);
  }

  /** 字节速率紧凑格式：0 / 320K / 1.2M / 1.5G（单位 = 每秒） */
  function fmtRate(bytesPerSec) {
    const b = Number(bytesPerSec) || 0;
    if (b < 1024) return '0';
    if (b < 1048576) return Math.round(b / 1024) + 'K';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + 'M';
    return (b / 1073741824).toFixed(1) + 'G';
  }
  function gb(bytes) {
    return ((Number(bytes) || 0) / 1073741824).toFixed(1);
  }

  class PetDock {
    constructor(sprite) {
      this.sprite = sprite;
      this.latest = null;
      this.offMetrics = null;

      // 几何（sprite 内 CSS 像素）：宽 0.68 宠物；顶边托住鞋底。
      // sprite.stage 被 translateY(bottomPad) 下移，因此 stage 底边在 sprite 内的 y = height + bottomPad；
      // 这里把顶边放在 stage 底边上 0.024×size 处（仅切入底部透明留白，不碰不透明像素）。
      // groundLift = 底座探出 sprite.winH 的高度：贴地时窗口要整体上抬这么多，底座才不被屏幕裁掉。
      const size = sprite.size;
      this.dockW = size * 0.68;
      this.dockH = size * 0.096;
      this.left = (size - this.dockW) / 2;
      this.top = sprite.height + sprite.bottomPad - size * 0.024;
      this.groundLift = Math.max(0, this.top + this.dockH - sprite.winH);

      // 显示偏好（默认开：底座是功能本体；菜单可关，localStorage 记忆）
      let stored = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch {
        /* 隐私模式等：退化为默认开 */
      }
      this.on = stored !== '0';

      injectStyle();
      this.el = document.createElement('div');
      this.el.className = 'pet-dock' + (this.on ? '' : ' is-off');
      this.el.setAttribute('role', 'button');
      this.el.setAttribute('aria-label', '系统监控底座，点击打开任务管理器');
      this.el.style.setProperty('--dock-w', this.dockW + 'px');
      this.el.style.setProperty('--dock-h', this.dockH + 'px');
      this.el.style.setProperty('--dock-top', this.top + 'px');

      // 配图区（图片素材）：碎碎念/对话带配图时显示在底座左侧，与头顶气泡同源（renderBubble 驱动）
      this.imgName = null;
      this.imgBox = document.createElement('div');
      this.imgBox.className = 'pet-dock-img';
      this.el.appendChild(this.imgBox);

      this.cells = {};
      for (const c of CELLS) {
        const cell = document.createElement('div');
        cell.className = 'dock-cell';
        cell.dataset.k = c.k;
        const line = document.createElement('div');
        line.className = 'dc-line';
        const label = document.createElement('span');
        label.className = 'dc-label';
        label.textContent = c.label;
        const value = document.createElement('span');
        value.className = 'dc-value';
        value.textContent = '—';
        const bar = document.createElement('div');
        bar.className = 'dc-bar';
        const fill = document.createElement('i');
        bar.appendChild(fill);
        line.appendChild(label);
        line.appendChild(value);
        cell.appendChild(line);
        cell.appendChild(bar);
        this.el.appendChild(cell);
        this.cells[c.k] = { cell, value, fill };
      }
      sprite.el.appendChild(this.el);

      // 点击：打开系统任务管理器（底座是整块按钮）
      const ac = new AbortController();
      this.ac = ac;
      this.el.addEventListener(
        'click',
        () => {
          if (window.petBridge && window.petBridge.openTaskManager) window.petBridge.openTaskManager();
        },
        { signal: ac.signal },
      );

      // 订阅指标（返回退订：sprite 重建/重载配置时随 dispose 回收，不重复挂监听）
      if (window.petBridge && window.petBridge.onMetrics) {
        this.offMetrics = window.petBridge.onMetrics((m) => {
          this.latest = m;
          this.render();
        });
      }
    }

    isVisible() {
      return this.on;
    }

    /** 命中测试：窗口坐标（与 onMouseMove 的 wx/wy 同系），四周放 6px 方便悬停 */
    hitTest(wx, wy) {
      if (!this.on) return false;
      const x = wx - this.sprite.margin.l - this.left;
      const y = wy - this.sprite.margin.t - this.top;
      const pad = 6;
      return x >= -pad && x <= this.dockW + pad && y >= -pad && y <= this.dockH + pad;
    }

    setOn(next) {
      const v = !!next;
      if (v === this.on) return;
      this.on = v;
      try {
        localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
      } catch {
        /* 存不了就只活在本会话 */
      }
      this.el.classList.toggle('is-off', !v);
      // groundLift 随显隐变化：静止时立刻重报一次窗口矩形（移动/飞行中下一帧自然带上）
      this.sprite.sendBounds(this.sprite.pos.x, this.sprite.pos.y);
      // 隐藏后立即把底座矩形从交互区拿掉，显示后纳入
      this.sprite.syncInputRegions();
      if (v) this.render();
    }

    toggle() {
      this.setOn(!this.on);
    }

    dispose() {
      this.ac.abort();
      if (this.offMetrics) {
        this.offMetrics();
        this.offMetrics = null;
      }
      this.el.remove();
    }

    // ---------- 渲染 ----------

    /** 配图（图片素材）：碎碎念/对话带配图时在底座左侧显示缩略图（与头顶气泡同源）。
     *  name 为空 → 收起；缓存名字，避免每拍指标重复重建 <img>（配图在 renderBubble 里同步）。 */
    syncImage(name) {
      const key = this.on ? String(name ?? '').trim() : '';
      if (key === this.imgName) return;
      this.imgName = key;
      this.imgBox.innerHTML = '';
      const img = key ? S.createMemeImage(key, BASE, this.sprite.assetRoot) : null;
      if (!img) {
        this.imgBox.classList.remove('is-on');
        return;
      }
      this.imgBox.appendChild(img);
      this.imgBox.classList.add('is-on');
    }

    setPct(k, pct, title) {
      const r = this.cells[k];
      if (!r) return;
      const p = pct === null || pct === undefined || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, Math.round(pct)));
      r.value.textContent = p === null ? '—' : p + '%';
      r.fill.style.width = (p ?? 0) + '%';
      r.cell.classList.toggle('is-hot', p !== null && p >= HOT_PCT && p < CRIT_PCT);
      r.cell.classList.toggle('is-crit', p !== null && p >= CRIT_PCT);
      if (title) r.cell.setAttribute('title', title);
    }

    render() {
      // 配图与指标同一拍刷新；即便指标还没到（latest=null）也先同步好配图
      this.syncImage(this.on && this.sprite.whisperOn ? this.sprite.whisperImage : '');
      if (!this.on || !this.latest) return;
      const m = this.latest;
      this.setPct('cpu', m.cpu, 'CPU 使用率 ' + (Number.isFinite(m.cpu) ? m.cpu + '%' : '不可用'));
      const memPct = m.memTotal > 0 ? Math.round((m.memUsed / m.memTotal) * 100) : null;
      this.setPct('mem', memPct, '内存 ' + gb(m.memUsed) + ' / ' + gb(m.memTotal) + ' GB（' + (memPct ?? '—') + '%）');
      this.setPct(
        'disk',
        m.diskPct,
        m.diskPct === null ? '磁盘性能计数器不可用' : '磁盘活动 ' + m.diskPct + '% · ' + fmtRate(m.diskBytes) + '/s',
      );
      // 网络：主值是上下行合计速率（对数刻度条），明细分开下行/上行放在 title
      const r = this.cells.net;
      const total = (Number(m.netUp) || 0) + (Number(m.netDown) || 0);
      r.value.textContent = fmtRate(total);
      const netPct = Math.max(0, Math.min(100, (Math.log10(1 + total) / Math.log10(1 + NET_FULL_BPS)) * 100));
      r.fill.style.width = netPct + '%';
      r.cell.classList.remove('is-hot', 'is-crit');
      r.cell.setAttribute('title', '网络  ↓ ' + fmtRate(m.netDown) + '/s   ↑ ' + fmtRate(m.netUp) + '/s');
      this.setPct('gpu', m.gpu, m.gpu === null ? 'GPU 性能计数器不可用' : 'GPU（3D）' + m.gpu + '%');
    }
  }

  window.PetDock = PetDock;
})();
