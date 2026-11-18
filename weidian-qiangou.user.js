// ==UserScript==
// @name         微店抢购助手(准点结算 · 自动勾选 · 到收银台就停)
// @namespace    https://github.com/companion/weidian-qiangou
// @version      1.0.0
// @description  微店定时开售商品:自动勾那一件 → 结算 → 刷新翻页 → 补勾「请选择」并点确定 → 点「提交订单」→ 跳到扫码页就停手,不碰付款。
// @author       companion
// @match        https://weidian.com/*
// @match        https://*.weidian.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 小工具 ----------
  const LS = 'wg_qiangou_cfg';
  const SS = 'wg_qiangou_state';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => ((el && el.innerText) || '').replace(/\s+/g, '');
  const visible = (el) => {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const leafByText = (re, tag) => {
    const all = [...document.querySelectorAll(tag || 'span,div,a,button,p,i,em')];
    return all.filter((e) => e.children.length === 0 && visible(e) && re.test(txt(e)));
  };

  let cfg = { time: '', armed: false, target: 0, fired: false };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(LS) || '{}')); } catch (e) {}
  const saveCfg = () => { try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (e) {} };

  // ---------- 点击(先原生 click,没反应再来一套合成事件)----------
  function once(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    try { el.click(); } catch (e) { return false; }
    return true;
  }
  function synth(el) {
    if (!el) return false;
    let r = { x: 0, y: 0, width: 0, height: 0 };
    try { r = el.getBoundingClientRect(); } catch (e) {}
    const o = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2
    };
    ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      const E = (t.indexOf('pointer') === 0 && window.PointerEvent) ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new E(t, o)); } catch (e) {}
    });
    return true;
  }
  // 点一下并确认「有变化」;没变化就补一套合成事件
  async function clickSure(el, changed, tries = 3) {
    if (!el) return false;
    for (let i = 0; i < tries; i++) {
      once(el);
      await sleep(120);
      if (!changed || changed()) return true;
      synth(el);
      await sleep(150);
      if (!changed || changed()) return true;
    }
    return false;
  }

  // ---------- 页面上的东西 ----------
  const onCart = () => location.href.indexOf('/new-cart/') >= 0;
  const onOrder = () => location.href.indexOf('/buy/add-order/') >= 0;
  const onCashier = () => /cashier|pay-h5|收银台/.test(location.href) || document.title.indexOf('收银台') >= 0;

  function cartCountdown() {
    const m = (document.body.innerText || '').match(/距开售[^0-9]{0,6}(\d{1,2}):(\d{2}):(\d{2})/)
      || (document.body.innerText || '').match(/开售[^0-9]{0,6}(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  }

  function itemCheckbox() {
    const row = document.querySelector('.partition_item .item') || document.querySelector('.item');
    if (!row) return null;
    return row.querySelector('i.theme-confirm-m.checkbox') || row.querySelector('.checkbox');
  }
  function settleBtn() {
    const b = document.querySelector('.go_buy');
    return b && visible(b) ? b : null;
  }

  const placeholder = () => leafByText(/请选择/)[0] || null;
  const modalOption = () => {
    const it = [...document.querySelectorAll('.choice_item')].filter(visible).pop();
    return it ? (it.querySelector('i.checkbox') || it) : null;
  };
  const modalOk = () => [...document.querySelectorAll('.choice_btn .btn')].filter(visible).pop() || null;
  const submitBtn = () => {
    const t = leafByText(/^提交订单$/).filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 40 && r.height > 18;
    }).pop();
    if (!t) return null;
    const cls = String(t.className || '') + ' ' + String((t.parentNode && t.parentNode.className) || '');
    return { el: t, locked: /cannot|disabled/i.test(cls) };
  };

  // ---------- 勾必选项 ----------
  async function fillOptions(maxRounds = 8) {
    let done = 0;
    for (let i = 0; i < maxRounds; i++) {
      if (onCashier() || !onOrder()) break;
      let o = modalOption();
      if (!o) {
        const p = placeholder();
        if (!p) break;
        once(p);
        for (let w = 0; w < 12 && !modalOption(); w++) await sleep(60);   // 等弹层出来
        o = modalOption();
        if (!o) break;
      }
      once(o);
      for (let w = 0; w < 10 && !modalOk(); w++) await sleep(50);
      const k = modalOk();
      if (k) once(k);
      for (let w = 0; w < 20 && (modalOption() || modalOk()); w++) await sleep(50);  // 等弹层关掉
      done++;
    }
    return done;
  }

  // ---------- 主循环 ----------
  let busy = false;
  let lastCart = 0;
  let lastFill = 0;
  let lastRefresh = 0;
  let submitted = false;

  function setState(s) {
    const el = document.getElementById('wg-state');
    if (el) el.textContent = s;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (onCashier()) {
        if (cfg.armed) { setState('到了扫码页,停手'); cfg.armed = false; saveCfg(); }
        return;
      }
      if (!cfg.armed) { return; }
      const now = Date.now() / 1000;
      const left = cfg.target ? cfg.target - now : 0;
      setState(cfg.target ? ('盯住,还剩 ' + Math.max(0, Math.round(left)) + ' 秒') : '盯住(未定时)');

      // 1. 购物车:开售前 25 秒摆好页面
      if (onCart() && left > 0 && left < 26 && now - lastCart > 3) {
        lastCart = now;
        const cb = itemCheckbox();
        if (cb) await clickSure(cb, () => true);
        await sleep(300);
        const go = settleBtn();
        if (go && !/结算\(0\)/.test(txt(go))) { once(go); await sleep(1200); }
        return;
      }

      // 2. 确认订单页
      if (onOrder()) {
        if (placeholder() || modalOption()) {
          if (now - lastFill > 0.8) {
            lastFill = now;
            const n = await fillOptions();
            if (n > 0) console.log('[微店抢购] 勾了', n, '个必选项');
          }
          return;
        }
        // 还没开售 → 靠刷新把这页翻过来
        if (left > -240 && left < 8 && now - lastRefresh > 2.5) {
          lastRefresh = now;
          const s = submitBtn();
          if (!s || s.locked) { setState('刷新翻页…'); location.reload(); return; }
        }
        const s = submitBtn();
        if (s && !s.locked && !submitted) {
          submitted = true;
          setState('点「提交订单」!');
          once(s.el);
          for (let w = 0; w < 40; w++) {
            await sleep(150);
            if (onCashier()) break;
          }
          if (onCashier()) {
            setState('到扫码页了 —— 该你扫码了');
            cfg.armed = false; saveCfg();
          } else {
            setState('点了提交,但没跳收银台');
            submitted = false;
          }
        }
      }
    } catch (e) {
      console.warn('[微店抢购]', e);
    } finally {
      busy = false;
    }
  }

  // ---------- 小面板 ----------
  function panel() {
    if (document.getElementById('wg-panel')) return;
    const d = document.createElement('div');
    d.id = 'wg-panel';
    d.innerHTML = [
      '<div class="wg-h"><b>微店抢购</b><span id="wg-state">待命</span></div>',
      '<div class="wg-row">开售 <input id="wg-time" size="9" placeholder="HH:MM:SS">',
      '<button id="wg-read">读倒计时</button></div>',
      '<div class="wg-row"><button id="wg-arm">开始盯</button>',
      '<button id="wg-stop">停</button><span id="wg-left"></span></div>',
      '<div class="wg-tip">停手点:跳到扫码页就结束,付款不动</div>'
    ].join('');
    const css = document.createElement('style');
    css.textContent = `
      #wg-panel{position:fixed;right:16px;bottom:90px;z-index:2147483000;background:#fff;border:1px solid #d8232a;
        border-radius:10px;padding:8px 10px;font:12px/1.6 system-ui,'Microsoft YaHei';box-shadow:0 6px 20px rgba(0,0,0,.18);color:#333}
      #wg-panel .wg-h{display:flex;gap:8px;align-items:center;margin-bottom:4px}
      #wg-panel .wg-h b{color:#d8232a}
      #wg-panel #wg-state{color:#666}
      #wg-panel .wg-row{display:flex;gap:6px;align-items:center;margin-top:4px}
      #wg-panel input{border:1px solid #ccc;border-radius:4px;padding:1px 4px;font:inherit}
      #wg-panel button{border:1px solid #d8232a;background:#fff;color:#d8232a;border-radius:5px;padding:1px 8px;font:inherit;cursor:pointer}
      #wg-panel button:hover{background:#d8232a;color:#fff}
      #wg-panel .wg-tip{color:#999;margin-top:4px}`;
    document.head.appendChild(css);
    document.body.appendChild(d);

    document.getElementById('wg-read').onclick = () => {
      const secs = cartCountdown();
      if (!secs) { setState('这页没倒计时'); return; }
      const t = new Date(Date.now() + secs * 1000);
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      cfg.time = hh + ':' + mm + ':' + ss;
      document.getElementById('wg-time').value = cfg.time;
      setState('开售 ' + cfg.time);
      saveCfg();
    };
    document.getElementById('wg-arm').onclick = () => {
      const v = document.getElementById('wg-time').value.trim();
      if (v) cfg.time = v;
      const m = cfg.time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (m) {
        const t = new Date();
        t.setHours(+m[1], +m[2], +(m[3] || 0), 0);
        cfg.target = t.getTime() / 1000;
        if (cfg.target < Date.now() / 1000) cfg.target += 86400;
      } else {
        cfg.target = 0;
      }
      cfg.armed = true; submitted = false;
      saveCfg();
      setState('开始了,去购物车那页等着');
    };
    document.getElementById('wg-stop').onclick = () => {
      cfg.armed = false; saveCfg(); setState('停了');
    };
    document.getElementById('wg-time').value = cfg.time || '';
    if (cfg.armed) setState('盯住中…');
  }

  panel();
  setInterval(tick, 100);
})();
