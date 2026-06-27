// ==UserScript==
// @name         西电选课助手（指定教学班）
// @namespace    local.xidian.course-helper
// @version      2.1.1
// @description  手动登录后，点击启动即尝试多个指定教学班；满员时限频重试。
// @match        https://xk.xidian.edu.cn/xsxk/*
// @run-at       document-start
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const PAGE = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const VERSION = '2.1.1';
  PAGE.__XDU_COURSE_SNIPER_LOADED__ = VERSION;

  const CONFIG = Object.freeze({
    targets: Object.freeze([
      Object.freeze({ key: '36', section: '[36]', teachers: Object.freeze(['胡景钊', '万波', '李荣涵', '李飞', '张晨曦']), label: '[36] 胡景钊,万波,李荣涵,李飞,张晨曦' }),
      Object.freeze({ key: '07', section: '[07]', teachers: Object.freeze(['黄超']), label: '[07] 黄超' }),
      Object.freeze({ key: '57', section: '[57]', teachers: Object.freeze(['刘慧']), label: '[57] 刘慧' }),
      Object.freeze({ key: '50', section: '[50]', teachers: Object.freeze(['李航', '黄伯虎', '赵佩佩', '杜军朝']), label: '[50] 李航,黄伯虎,赵佩佩,杜军朝' }),
    ]),
    retryMinMs: 120,
    retryMaxMs: 220,
    maxRunHours: 8,
  });

  const KEY = 'xdu_course_sniper_v1';
  const savedState = loadState();
  const state = Object.assign({
    armed: false,
    running: false,
    paused: false,
    payload: null,
    payloads: {},
    skippedTargetKeys: [],
    batchId: '',
    attempts: 0,
    runStartedAt: 0,
    lastMessage: '等待进入选课页',
  }, savedState);

  if (savedState.version !== VERSION) {
    state.armed = false;
    state.running = false;
    state.paused = false;
    state.payload = null;
    state.payloads = {};
    state.skippedTargetKeys = [];
    state.batchId = '';
    state.attempts = 0;
    state.lastMessage = '已切换目标课，请重新搜索目标教学班以捕获数据';
  }

  let timer = null;
  let verifyTimer = null;
  let panel = null;
  let statusNode = null;
  let detailNode = null;
  let startButton = null;

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      // running 只代表上一页的状态；新页面必须重新调度。
      saved.running = false;
      return saved;
    } catch (_) {
      return {};
    }
  }

  function persist() {
    localStorage.setItem(KEY, JSON.stringify({
      version: VERSION,
      armed: state.armed,
      paused: state.paused,
      payload: state.payload,
      payloads: state.payloads,
      skippedTargetKeys: state.skippedTargetKeys,
      batchId: state.batchId,
      attempts: state.attempts,
      runStartedAt: state.runStartedAt,
      lastMessage: state.lastMessage,
    }));
  }

  function stringify(value) {
    try { return JSON.stringify(value); } catch (_) { return ''; }
  }

  function normalized(value) {
    return String(value ?? '').replace(/\s+/g, '').toLowerCase();
  }

  function findMatchedTarget(value) {
    const text = normalized(stringify(value));
    return CONFIG.targets.find((target) => {
      const section = normalized(target.section);
      const sectionNumber = normalized(target.section.replace(/\D/g, ''));
      const hasSection = text.includes(section) ||
        text.includes(`教学班${sectionNumber}`) ||
        text.includes(`序号${sectionNumber}`) ||
        text.includes(`"${sectionNumber}"`) ||
        text.includes(`:${sectionNumber}`) ||
        text.includes(`：${sectionNumber}`);
      const hasTeachers = target.teachers.every((teacher) => text.includes(normalized(teacher)));
      return hasSection && hasTeachers;
    }) || null;
  }

  function containsTarget(value) {
    return Boolean(findMatchedTarget(value));
  }

  function skippedTargetSet() {
    return new Set(Array.isArray(state.skippedTargetKeys) ? state.skippedTargetKeys : []);
  }

  function collectCandidates(value, depth = 0, candidates = []) {
    if (!value || typeof value !== 'object' || depth > 12) return candidates;
    const clazzId = value.clazzId ?? value.CLAZZID ?? value.JXBID ?? value.jxbId;
    const secretVal = value.secretVal ?? value.SECRETVAL;
    const matchedTarget = findMatchedTarget(value);
    if (clazzId && secretVal && matchedTarget) {
      candidates.push({
        clazzType: String(value.clazzType ?? value.CLAZZTYPE ?? currentClazzType()),
        clazzId: String(clazzId),
        secretVal: String(secretVal),
        targetKey: matchedTarget.key,
        targetLabel: matchedTarget.label,
      });
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      collectCandidates(child, depth + 1, candidates);
    }
    return candidates;
  }

  function bestAvailablePayload() {
    const skipped = skippedTargetSet();
    const payloads = state.payloads || {};
    for (const target of CONFIG.targets) {
      if (!skipped.has(target.key) && payloads[target.key]) return payloads[target.key];
    }
    return null;
  }

  function switchToBestPayload(reason = '') {
    const next = bestAvailablePayload();
    if (!next) {
      state.payload = null;
      state.lastMessage = reason || '所有候选教学班都已跳过或尚未捕获';
      persist();
      render();
      return false;
    }
    const previousKey = state.payload?.targetKey;
    state.payload = next;
    state.batchId = getBatchId();
    if (previousKey !== next.targetKey) {
      state.lastMessage = reason
        ? `${reason}；切换到 ${next.targetLabel}`
        : `已锁定教学班：${next.targetLabel}`;
      persist();
      render();
    }
    return true;
  }

  function findTargetRecord(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return null;
    if (findMatchedTarget(value)) {
      return value;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = findTargetRecord(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function currentClazzType() {
    return String(PAGE.grablessonsVue?.teachingClassType || 'XGKC');
  }

  function inspectCurrentPageData() {
    try {
      const vm = PAGE.grablessonsVue;
      if (!vm) return;
      const targetRecord = findTargetRecord(vm.courseList);
      if (state.running && targetRecord && String(targetRecord.SFYX) === '1') {
        stop('选课成功：网站已将目标教学班标记为已选', true);
        return;
      }
      inspectResponse(vm.courseList);
      if (!state.payload) inspectResponse(vm.catchCourseList);
    } catch (_) {}
  }

  function inspectResponse(value, url = '') {
    inspectServerMessage(value, url);
    const candidates = collectCandidates(value);
    if (!candidates.length) return;
    const previousPayload = state.payload;
    state.payloads = state.payloads || {};
    for (const candidate of candidates) {
      state.payloads[candidate.targetKey] = candidate;
    }
    switchToBestPayload();
    if (!previousPayload && state.payload && !state.running) {
      state.lastMessage = `已锁定教学班：${state.payload.targetLabel || '目标候选课'}`;
    }
    persist();
    render();
    // 只在尚未进入运行循环时启动调度；运行中再次扫描课程数据
    // 不能调用 schedule()，否则会清除下一次重试定时器。
    if (state.armed && !state.running) schedule();
  }

  function inspectServerMessage(value, url = '') {
    if (!state.running || !state.payload || !value || typeof value !== 'object') return;
    if (String(url).includes('/elective/clazz/add')) return;
    const message = String(value.msg ?? value.message ?? '');
    if (!message || !isCapacityMiss(message)) return;
    if (skipCurrentTarget(`返回“${message}”`)) {
      clearTimeout(timer);
      timer = setTimeout(submitOnce, 60);
      return;
    }
    stop('已停止：所有候选教学班均已满或尚未捕获可用数据');
  }

  function patchFetch() {
    if (!window.fetch) return;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      response.clone().json().then((value) => inspectResponse(value, String(args[0] || ''))).catch(() => {});
      return response;
    };
  }

  function patchXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (...args) {
      this.__xduUrl = args[1];
      return originalOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        try {
          const value = this.responseType === 'json'
            ? this.response
            : JSON.parse(this.responseText);
          inspectResponse(value, String(this.__xduUrl || ''));
        } catch (_) {}
      });
      return originalSend.apply(this, args);
    };
  }

  function getBatchId() {
    const fromUrl = new URL(location.href).searchParams.get('batchId');
    if (fromUrl) return fromUrl;
    try {
      const batch = JSON.parse(sessionStorage.getItem('currentBatch') || '{}');
      return String(batch.code || batch.batchId || state.batchId || '');
    } catch (_) {
      return state.batchId || '';
    }
  }

  function getToken() {
    return sessionStorage.getItem('token') || '';
  }

  function jitter() {
    return Math.round(CONFIG.retryMinMs + Math.random() *
      (CONFIG.retryMaxMs - CONFIG.retryMinMs));
  }

  function classify(result, httpStatus) {
    const code = Number(result?.code ?? httpStatus);
    const message = String(result?.msg ?? result?.message ?? `HTTP ${httpStatus}`);
    if (code === 200 || /操作成功|选课成功/.test(message)) return { kind: 'success', message };
    if (/已经选过|已经选择|该课程已选|重复选课|请勿重复选择/.test(message)) {
      return { kind: 'success', message };
    }
    if (/未登录|登录.*失效|token|认证.*失败|无权限/.test(message)) return { kind: 'fatal', message };
    if (/时间冲突|学分.*上限|不可选|不允许|不在培养|先修|校区.*冲突/.test(message)) {
      return { kind: 'fatal', message };
    }
    if (/已满|人数|容量|余量|未到|未开始|繁忙|稍后|失败/.test(message) || code >= 500) {
      return { kind: 'retry', message };
    }
    return { kind: 'retry', message };
  }

  function isCapacityMiss(message) {
    return /已满|人数.*满|容量.*满|容量不足|余量不足|名额不足|没有余量|无余量|队列.*满/.test(String(message || ''));
  }

  function skipCurrentTarget(reason) {
    if (!state.payload?.targetKey) return false;
    const key = state.payload.targetKey;
    const skipped = skippedTargetSet();
    skipped.add(key);
    state.skippedTargetKeys = [...skipped];
    return switchToBestPayload(`${state.payload.targetLabel || key} ${reason || '无可用名额'}`);
  }

  async function submitOnce() {
    if (!state.running || !state.payload) return;
    const batchId = getBatchId();
    if (!getToken() || !batchId) {
      stop('登录会话或选课轮次已失效，请重新登录并进入本轮选课页');
      return;
    }
    if (!PAGE.axios?.post) {
      stop('页面原生请求组件尚未就绪，请刷新选课页');
      return;
    }

    state.attempts += 1;
    render();
    try {
      // 使用网站自身的 axios；由网站原生拦截器显示“未开始选课”等提示。
      const { targetKey, targetLabel, ...submitPayload } = state.payload;
      const response = await PAGE.axios.post('/elective/clazz/add', { ...submitPayload });
      if (!state.running) return;
      const result = response?.data || {};

      if (Number(result?.code) === 301) {
        state.payload.isConfirm = '1';
        state.lastMessage = `第 ${state.attempts} 次：收到二次确认，将自动确认（${result.msg || '服务器提醒'}）`;
        persist();
        render();
        timer = setTimeout(submitOnce, 300);
        return;
      }

      if (Number(result?.code) === 200) {
        state.lastMessage = `第 ${state.attempts} 次：已进入选课队列；不中断提交，后台核验结果`;
        persist();
        render();
        queueVerify(300);
      } else {
        const verdict = classify(result, response?.status || 200);
        state.lastMessage = `第 ${state.attempts} 次：${verdict.message}`;
        persist();
        render();
        if (verdict.kind === 'retry' && isCapacityMiss(verdict.message)) {
          if (skipCurrentTarget('已满')) {
            timer = setTimeout(submitOnce, 60);
            return;
          }
          stop('已停止：所有候选教学班均已满或尚未捕获可用数据');
          return;
        }
        if (verdict.kind === 'success') {
          stop(`选课成功：${verdict.message}`, true);
          return;
        }
        if (verdict.kind === 'fatal') {
          stop(`已停止：${verdict.message}`);
          return;
        }
      }
    } catch (error) {
      state.lastMessage = `网络异常，将重试：${error.message}`;
      render();
    }

    if (Date.now() > state.runStartedAt + CONFIG.maxRunHours * 3600000) {
      stop(`已达到 ${CONFIG.maxRunHours} 小时运行上限`);
      return;
    }
    timer = setTimeout(submitOnce, jitter());
  }

  function queueVerify(delayMs = 1000) {
    if (!state.running || verifyTimer) return;
    verifyTimer = setTimeout(() => {
      verifyTimer = null;
      verifySelection();
    }, delayMs);
  }

  async function verifySelection() {
    if (!state.running) return;
    const batchId = getBatchId();
    if (!getToken() || !batchId) {
      stop('登录会话或选课轮次已失效，请重新登录');
      return;
    }
    try {
      const response = await PAGE.axios.post('/elective/select', {});
      if (!state.running) return;
      const result = response?.data || {};
      if (Number(result?.code) === 200 && containsTarget(result?.data)) {
        stop('选课成功：已在“已选课程”中核验到目标教学班', true);
        return;
      }
      if (Number(result?.code) === 401 || /未登录|失效|token/i.test(String(result?.msg || ''))) {
        stop(`已停止：${result?.msg || '登录会话失效'}`);
        return;
      }
      state.lastMessage = '队列尚未产生成功结果，将继续尝试';
      persist();
      render();
    } catch (error) {
      state.lastMessage = `核验结果失败，将继续尝试：${error.message}`;
      persist();
      render();
    }
  }

  async function schedule() {
    clearTimeout(timer);
    clearTimeout(verifyTimer);
    verifyTimer = null;
    if (!state.armed || state.running) return;
    if (!state.payload) {
      state.lastMessage = '尚未捕获目标课：请在选课页搜索该课程，使课程出现在列表中';
      render();
      return;
    }
    state.running = true;
    state.lastMessage = '开始提交选课请求';
    persist();
    render();
    submitOnce();
  }

  function arm() {
    if (state.running || state.armed) {
      stop('已由用户暂停；再次点击“启动”可恢复');
      return;
    }
    state.paused = false;
    state.armed = true;
    state.skippedTargetKeys = [];
    switchToBestPayload();
    state.attempts = 0;
    state.runStartedAt = Date.now();
    state.lastMessage = state.payload
      ? '正在校准服务器时间'
      : '已启动；请搜索目标课程以捕获教学班数据';
    persist();
    render();
    schedule();
  }

  function stop(message, success = false) {
    clearTimeout(timer);
    clearTimeout(verifyTimer);
    timer = null;
    verifyTimer = null;
    state.running = false;
    state.armed = false;
    state.paused = true;
    state.runStartedAt = 0;
    state.lastMessage = message;
    persist();
    render();
    if (success) notifySuccess(message);
  }

  function notifySuccess(message) {
    try {
      const audio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=');
      audio.play().catch(() => {});
    } catch (_) {}
    if (Notification.permission === 'granted') {
      new Notification('西电选课助手', { body: message });
    }
    alert(message);
  }

  function clearCaptured() {
    if (state.running) return;
    state.payload = null;
    state.batchId = '';
    state.lastMessage = '已清除捕获数据，请重新搜索目标课程';
    persist();
    render();
  }

  function render() {
    if (!panel) return;
    const captured = state.payload ? '已捕获' : '未捕获';
    const mode = state.running ? '运行中' : state.armed ? '已武装' : '未启动';
    statusNode.textContent = `${mode} · 课程数据${captured} · 已尝试 ${state.attempts} 次`;
    detailNode.textContent = state.lastMessage;
    startButton.textContent = (state.running || state.armed) ? '停止' : '启动';
    startButton.style.background = (state.running || state.armed) ? '#b42318' : '#1769aa';
  }

  function mountPanel() {
    if (panel || !document.body) return;
    panel = document.createElement('section');
    panel.id = 'xdu-course-sniper-panel';
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:330px', 'padding:14px', 'border-radius:10px',
      'background:#fff', 'color:#1f2328', 'border:1px solid #bbb',
      'box-shadow:0 8px 28px rgba(0,0,0,.24)', 'font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif'
    ].join(';');
    panel.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">西电选课助手 <span style="font-weight:500;color:#667085">v${VERSION}</span></div>
      <div style="font-size:13px;margin-bottom:8px">${CONFIG.targets.map((target) => target.label).join(' / ')}</div>
      <div id="xdu-sniper-status" style="font-weight:600"></div>
      <div id="xdu-sniper-detail" style="margin:5px 0 10px;color:#555;word-break:break-word"></div>
      <button id="xdu-sniper-start" style="color:white;border:0;border-radius:6px;padding:7px 16px;cursor:pointer"></button>
      <button id="xdu-sniper-clear" style="margin-left:6px;border:1px solid #999;border-radius:6px;padding:6px 10px;background:#fff;cursor:pointer">重新捕获</button>
    `;
    document.body.appendChild(panel);
    statusNode = panel.querySelector('#xdu-sniper-status');
    detailNode = panel.querySelector('#xdu-sniper-detail');
    startButton = panel.querySelector('#xdu-sniper-start');
    startButton.addEventListener('click', arm);
    panel.querySelector('#xdu-sniper-clear').addEventListener('click', clearCaptured);
    render();
    if (state.armed) schedule();
  }

  patchFetch();
  patchXHR();
  setInterval(inspectCurrentPageData, 1000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
  } else {
    mountPanel();
  }
}());
