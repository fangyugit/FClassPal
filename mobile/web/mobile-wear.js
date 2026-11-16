/* ============================================================================
 * FClassPal 安卓壳 · 「连电脑」面板（v2.6.6）——模拟 WearOS 当客户端
 *
 * 手机端原本只能被当成本机启动器用；这个文件补上反向能力：手机像手表一样
 * 去连**电脑**（或另一台开了「被连接」的手机），看到对方的分组与条目，
 * 点一下让**对方**打开它，还能远程调对方的透明度 / 窗口大小 / 布局 / 主题。
 *
 * 协议一侧完全复用桌面版 lan-server.js 的那套（/fcp/pair|state|action），
 * 所以对手表、电脑、手机三方来说，谁是主机都一样。
 *
 * 为什么走原生而不是 fetch：Capacitor 页面是 https://localhost 源，
 * 请求 http://192.168.x.x 会被 WebView 的混合内容策略拦掉，UDP 广播 JS 也没有 API。
 * 原生接口由 mobile-bridge.js 包成 window.FCP_LAN（PalBridge 插件 + lan/ 包的 Java）。
 *
 * 界面挂在设置面板里（append 一个 section），不改渲染层任何现有 DOM：
 * renderer/ 那份代码桌面版也在用，动它的风险远大于收益。
 * ==========================================================================*/
(function () {
  'use strict';

  var LAN = window.FCP_LAN;
  if (!LAN) return;          // 没有原生插件（纯浏览器预览）：整块不出现

  var SECTION_ID = 'fcpLanSection';

  var S = {
    paired: false,
    ip: '',
    port: 47820,
    name: '',
    code: '',            // 手输的配对码：render 会重建输入框，不记住就得重打一遍
    snap: null,          // 对方快照
    groupId: null,       // 正在看哪个分组（null = 分组列表）
    busy: false,
    note: '',
    hosts: null          // 发现结果（null = 还没搜过）
  };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function ic(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ic');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + (name || 'i-star'));
    svg.appendChild(use);
    return svg;
  }

  function btn(label, onClick, cls) {
    var b = el('button', 'fl-btn' + (cls ? ' ' + cls : ''), label);
    b.addEventListener('click', onClick);
    return b;
  }

  /* ---------- 挂载：设置面板底部追加一节 ---------- */
  function mount() {
    if (document.getElementById(SECTION_ID)) return true;
    var body = document.querySelector('#settingsPanel .panel-body');
    if (!body) return false;
    var sec = el('section', 'set-sec');
    sec.id = SECTION_ID;
    var h = el('h3', null, '电脑联动');
    sec.appendChild(h);
    sec.appendChild(el('div', 'fl-body'));
    body.appendChild(sec);
    return true;
  }

  function root() {
    var sec = document.getElementById(SECTION_ID);
    return sec ? sec.querySelector('.fl-body') : null;
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var box = root();
    if (!box) return;
    box.innerHTML = '';

    /* 状态 */
    var line = el('div', 'fl-status');
    if (S.busy) line.textContent = '正在连接…';
    else if (S.paired) line.textContent = '已连接 ' + (S.name || S.ip);
    else line.textContent = '未连接';
    box.appendChild(line);
    if (S.note) box.appendChild(el('div', 'fl-note', S.note));

    if (!S.paired) { renderPairing(box); return; }
    renderRemote(box);
  }

  function renderPairing(box) {
    /* 自动发现 */
    var row = el('div', 'fl-row');
    row.appendChild(btn('发现附近', function () { discover(); }, 'primary'));
    box.appendChild(row);

    if (S.hosts && S.hosts.length) {
      var list = el('div', 'fl-list');
      S.hosts.forEach(function (h) {
        var r = el('button', 'fl-row-item');
        var main = el('span', 'fl-row-main');
        main.appendChild(ic('i-watch'));
        main.appendChild(el('span', 'fl-row-name', h.name || h.ip));
        main.appendChild(el('small', 'fl-row-meta', h.ip + ' · ' + (h.port || 47820)));
        r.appendChild(main);
        r.addEventListener('click', function () {
          S.ip = h.ip;
          S.port = h.port || 47820;
          render();
          var inp = document.getElementById('flCode');
          if (inp) inp.focus();
        });
        list.appendChild(r);
      });
      box.appendChild(list);
    } else if (S.hosts) {
      box.appendChild(el('div', 'fl-note', '没搜到。检查是否同一 Wi-Fi，或下面手输地址'));
    }

    /* 手动：地址 + 配对码 */
    var ipLine = el('div', 'fl-row');
    var ipIn = el('input', 'fl-input');
    ipIn.id = 'flIp';
    ipIn.placeholder = '192.168.1.10';
    ipIn.value = S.ip || '';
    ipIn.setAttribute('inputmode', 'decimal');
    ipLine.appendChild(ipIn);
    var codeIn = el('input', 'fl-input fl-code');
    codeIn.id = 'flCode';
    codeIn.placeholder = '6 位码';
    codeIn.setAttribute('inputmode', 'numeric');
    codeIn.maxLength = 6;
    /* ★ 必须回填：render() 每次重建输入框，不回填的话"点连接失败一次 → 码没了"，
     * 用户以为是自己没输，实际是我们把 DOM 换掉了。 */
    codeIn.value = S.code || '';
    ipLine.appendChild(codeIn);
    box.appendChild(ipLine);

    ipIn.addEventListener('input', function () { S.ip = ipIn.value.trim(); });
    codeIn.addEventListener('input', function () {
      codeIn.value = codeIn.value.replace(/\D/g, '').slice(0, 6);
      S.code = codeIn.value;
    });

    var goRow = el('div', 'fl-row');
    goRow.appendChild(btn('连接', function () {
      var ip = (ipIn.value || '').trim();
      var code = (codeIn.value || '').replace(/\D/g, '');
      if (!ip) { S.note = '先填地址'; render(); return; }
      if (code.length !== 6) { S.note = '配对码是 6 位数字'; render(); return; }
      pair(ip, S.port || 47820, code);
    }, 'primary'));
    box.appendChild(goRow);
  }

  function renderRemote(box) {
    var snap = S.snap;
    var head = el('div', 'fl-row');
    head.appendChild(btn('刷新', function () { refresh(true); }));

    var group = null;
    if (snap && S.groupId) {
      (snap.groups || []).forEach(function (g) { if (g.id === S.groupId) group = g; });
    }
    if (group) {
      head.appendChild(btn('返回', function () { S.groupId = null; render(); }));
    } else {
      head.appendChild(btn('电脑设置', function () { openSettings(); }));
    }
    head.appendChild(btn('断开', function () { forget(); }, 'danger'));
    box.appendChild(head);

    if (!snap) { box.appendChild(el('div', 'fl-note', '正在读取…')); return; }

    if (!group) {
      var gs = snap.groups || [];
      if (!gs.length) { box.appendChild(el('div', 'fl-note', '对方还没有分组')); return; }
      var glist = el('div', 'fl-list');
      gs.forEach(function (g) {
        var r = el('button', 'fl-row-item');
        var main = el('span', 'fl-row-main');
        main.appendChild(ic('i-folder'));
        main.appendChild(el('span', 'fl-row-name', g.name || '分组'));
        main.appendChild(el('small', 'fl-row-meta', (g.items || []).length + ' 项'));
        r.appendChild(main);
        r.addEventListener('click', function () { S.groupId = g.id; render(); });
        glist.appendChild(r);
      });
      box.appendChild(glist);
      return;
    }

    var items = group.items || [];
    if (!items.length) { box.appendChild(el('div', 'fl-note', '这个分组是空的')); return; }
    var ilist = el('div', 'fl-list');
    renderItems(ilist, items);
    box.appendChild(ilist);
  }

  function renderItems(host, items) {
    items.forEach(function (it) {
      var r = el('button', 'fl-row-item');
      var main = el('span', 'fl-row-main');
      main.appendChild(ic(it.kind === 'folder' ? 'i-folder' : (it.icon || 'i-star')));
      main.appendChild(el('span', 'fl-row-name', it.name || '未命名'));
      r.appendChild(main);
      if (it.kind === 'folder') {
        /* 文件夹就地展开一层：手表端是进二级页，手机上直接展开更省事 */
        var kids = el('div', 'fl-list fl-kids');
        renderItems(kids, it.items || []);
        var wrap = el('div');
        wrap.appendChild(r);
        wrap.appendChild(kids);
        kids.style.display = 'none';
        r.addEventListener('click', function () {
          kids.style.display = kids.style.display === 'none' ? '' : 'none';
        });
        host.appendChild(wrap);
        return;
      }
      r.addEventListener('click', function () { launch(it); });
      host.appendChild(r);
    });
  }

  /* ---------- 远程设置（透明度 / 窗口 / 布局 / 主题） ---------- */
  function openSettings() {
    var box = root();
    if (!box || !S.snap) return;
    box.innerHTML = '';
    var snap = S.snap;
    box.appendChild(el('div', 'fl-status', '电脑设置'));

    function row(label, make) {
      var r = el('div', 'fl-row');
      r.appendChild(el('small', 'fl-row-meta', label));
      make(r);
      box.appendChild(r);
    }

    row('透明度 ' + Math.round((snap.opacity || 0.55) * 100) + '%', function (r) {
      r.appendChild(btn('−', function () { set('opacity', { value: Math.max(0.2, (snap.opacity || 0.55) - 0.1) }); }));
      r.appendChild(btn('＋', function () { set('opacity', { value: Math.min(1, (snap.opacity || 0.55) + 0.1) }); }));
    });
    row('窗口 ' + (snap.winW || 0) + '×' + (snap.winH || 0), function (r) {
      r.appendChild(btn('−', function () { set('size', { delta: -40 }); }));
      r.appendChild(btn('＋', function () { set('size', { delta: 40 }); }));
    });
    row('布局 ' + (snap.layout === 'free' ? '自由' : '网格'), function (r) {
      r.appendChild(btn(snap.layout === 'free' ? '改网格' : '改自由', function () {
        set('layout', { value: snap.layout === 'free' ? 'grid' : 'free' });
      }));
    });

    var themeName = snap.theme || '';
    (snap.themes || []).forEach(function (t) { if (t.id === snap.theme) themeName = t.name; });
    box.appendChild(el('div', 'fl-status', '主题：' + themeName));
    var tl = el('div', 'fl-list');
    (snap.themes || []).forEach(function (t) {
      var r = el('button', 'fl-row-item');
      var main = el('span', 'fl-row-main');
      main.appendChild(ic('i-palette'));
      main.appendChild(el('span', 'fl-row-name', (t.id === snap.theme ? '● ' : '') + (t.name || t.id)));
      r.appendChild(main);
      r.addEventListener('click', function () {
        if (t.id === snap.theme) return;
        set('theme', { value: t.id });
      });
      tl.appendChild(r);
    });
    box.appendChild(tl);

    var back = el('div', 'fl-row');
    back.appendChild(btn('返回', function () { render(); }));
    box.appendChild(back);
  }

  function set(key, extra) {
    if (S.busy) return;
    S.busy = true; S.note = ''; render();
    var data = { key: key };
    Object.keys(extra || {}).forEach(function (k) { data[k] = extra[k]; });
    LAN.action('set', data).then(function (r) {
      S.busy = false;
      if (r.ok && r.body && r.body.state) S.snap = r.body.state;
      else if (!r.ok) S.note = '电脑没响应';
      render();
    });
  }

  /* ---------- 动作 ---------- */
  function discover() {
    if (S.busy) return;
    S.busy = true; S.note = ''; S.hosts = null; render();
    LAN.discover(1800).then(function (list) {
      S.busy = false;
      S.hosts = list || [];
      if (S.hosts.length === 1 && !S.ip) {
        S.ip = S.hosts[0].ip;
        S.port = S.hosts[0].port || 47820;
      }
      render();
      var inp = document.getElementById('flCode');
      if (inp && S.hosts.length === 1) inp.focus();
    });
  }

  /* 把原生/协议错误翻成人话（v2.6.6-fix）。
   * `error` 有两种来源：协议给的短码（bad-code / too-many-tries），和 Java 异常
   * 原文（如 "Cleartext HTTP traffic to 192.168.1.7 not permitted"）。所以先精确
   * 匹配、再模糊匹配，最后兜底把原文截一段附上 —— 排查时那一句最值钱。 */
  function whyFailed(err) {
    var e = String(err || '');
    if (e === 'bad-code') return '配对码不对，看一眼电脑上显示的 6 位码';
    if (e === 'too-many-tries') return '试太多次了，等一分钟再试';
    if (e === 'no-plugin') return '这个安装包缺局域网模块，需要更新 App';
    if (e === 'not-fclasspal') return '端口通了，但那台设备不是 FClassPal';
    if (/Cleartext|not permitted/i.test(e)) return '系统拦了明文 HTTP（旧版才有这问题，请更新 App）';
    if (/timed out|timeout|ETIMEDOUT/i.test(e)) return '等回应超时：同一个 Wi-Fi 吗？电脑防火墙放行了吗？';
    if (/refused|ECONNREFUSED/i.test(e)) return '对方端口没开：先在电脑上打开「局域网联动」';
    if (/unreachable|ENETUNREACH|EHOSTUNREACH/i.test(e)) return '网络到不了那台设备，检查 Wi-Fi 与 IP';
    return '连不上' + (e ? '：' + e.slice(0, 60) : '：对方没有回应');
  }

  function pair(ip, port, code) {
    if (S.busy) return;
    S.busy = true; S.note = ''; render();
    /* 先 ping 再配对：ping 免鉴权，能把"端口不通 / 明文被拦 / 码不对"分开。
     * 少了这一步，所有失败都长一个样，用户和我们都没法往下查。 */
    var pre = (typeof LAN.ping === 'function')
      ? LAN.ping(ip, port)
      : Promise.resolve({ ok: true });
    pre.then(function (pg) {
      if (!pg.ok) {
        S.busy = false;
        S.note = whyFailed(pg.error);
        render();
        return null;
      }
      return LAN.pair(ip, port, code);
    }).then(function (r) {
      if (!r) return;
      S.busy = false;
      if (!r.ok) {
        S.note = whyFailed(r.error);
        render();
        return;
      }
      S.paired = true;
      S.ip = ip;
      S.port = port;
      S.name = (r.body && r.body.name) || ip;
      S.note = '';
      refresh(true);
    });
  }

  function forget() {
    LAN.forget().then(function () {
      S.paired = false;
      S.snap = null;
      S.groupId = null;
      S.hosts = null;
      S.note = '';
      render();
    });
  }

  function refresh(showBusy) {
    if (showBusy) { S.busy = true; render(); }
    LAN.state().then(function (r) {
      S.busy = false;
      if (!r.ok) {
        /* 401 = 对方把我解绑了 / 服务关了：退回未连接，别装作还连着 */
        S.paired = false;
        S.snap = null;
        S.note = '连接已失效，请重新配对';
        render();
        return;
      }
      S.snap = r.state || null;
      if (S.snap && S.snap.title) S.name = S.name || S.snap.title;
      render();
    });
  }

  function launch(it) {
    if (S.busy) return;
    S.busy = true; render();
    LAN.action('launch', { itemId: it.id }).then(function (r) {
      S.busy = false;
      var msg = r.body && r.body.result && r.body.result.message;
      S.note = r.ok ? (msg || '已发送') : '对方没响应';
      if (r.ok && r.body && r.body.state) S.snap = r.body.state;
      render();
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    if (!mount()) return;
    render();
    LAN.pairing().then(function (p) {
      if (!p || !p.paired) return;
      S.paired = true;
      S.ip = p.ip || '';
      S.port = p.port || 47820;
      S.name = p.name || p.ip || '';
      render();
      refresh(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 设置面板每次打开都重挂一次：渲染层可能会重建 panel-body 里的节点。
   * 入口有两套：桌面壳是 #btnSettings，**手机壳没有这个按钮**，设置是从右键/
   * 长按菜单的 .ctx-item[data-act="settings"] 打开的 —— 只认前者的话这条兜底
   * 在手机上等于没写（首屏能挂上，但真被重建过就再也回不来）。 */
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t !== document) {
      if (t.id === 'btnSettings' ||
          (t.getAttribute && t.getAttribute('data-act') === 'settings')) {
        setTimeout(init, 60);
        return;
      }
      t = t.parentNode;
    }
  }, true);
})();
