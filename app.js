/* app.js — 教练课时统计 PWA 核心逻辑（腾讯云开发 CloudBase 实时同步，多台手机共享数据） */

import cloudbase from "https://esm.sh/@cloudbase/js-sdk@3.9.4";

// ---------------------------------------------------------------------------
// CloudBase 初始化：所有手机共用同一个云端数据库，
// 任意一台手机的增删改都会实时推送到其他所有手机。
// ---------------------------------------------------------------------------
const CLOUDBASE_ENV = "worktime-d0g4mlkmp3769259b";

const cbApp = cloudbase.init({ env: CLOUDBASE_ENV });
const cbAuth = cbApp.auth({ persistence: 'local' });
const cbdb = cbApp.database();

const COACHES_COL = 'coaches';
const RECORDS_COL = 'records';

// CloudBase 的写入接口失败时不一定 reject，也可能 resolve 出 { code, message }，
// 这里统一转成"失败就 reject"，配合下面各处的 .catch(...) 使用。
function unwrap(promise) {
  return promise.then(res => {
    if (res && res.code) throw new Error(res.message || res.code);
    return res;
  });
}

const DB = {
  addCoach(name) {
    return unwrap(cbdb.collection(COACHES_COL).add({ name, status: 'active', createdAt: Date.now() }));
  },
  updateCoach(coach) {
    const { id, ...data } = coach;
    return unwrap(cbdb.collection(COACHES_COL).doc(id).update(data));
  },
  addRecord(rec) {
    rec.createdAt = Date.now();
    rec.updatedAt = Date.now();
    return unwrap(cbdb.collection(RECORDS_COL).add(rec));
  },
  updateRecord(rec) {
    const { id, ...data } = rec;
    data.updatedAt = Date.now();
    return unwrap(cbdb.collection(RECORDS_COL).doc(id).update(data));
  },
  deleteRecord(id) {
    return unwrap(cbdb.collection(RECORDS_COL).doc(id).remove());
  },
  deleteCoach(id) {
    return unwrap(cbdb.collection(COACHES_COL).doc(id).remove());
  }
};

// 写入/同步失败时用醒目的弹窗提示（而不是一闪而过的小提示），
// 避免"数据其实没保存成功，但用户没注意到"的情况——
// 常见原因是 CloudBase 后台的安全规则或匿名登录没配置好。
function reportError(action, err) {
  console.error(action, err);
  const detail = (err && err.message) ? err.message : String(err);
  alert(`${action}失败\n\n错误信息：${detail}\n\n请把这个提示截图发给开发者。`);
}

// 建立实时监听：任何一台手机的数据变化都会自动推送过来并刷新当前页面
function startRealtimeSync() {
  cbdb.collection(COACHES_COL).watch({
    onChange: snapshot => {
      coaches = snapshot.docs.map(d => ({ ...d, id: d._id }))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      if (currentView === 'entry') { renderCoaches(); renderCoachSelect(); }
      if (currentView === 'home') renderHome();
      if (currentView === 'stats') renderStats();
    },
    onError: err => reportError('云端数据同步', err)
  });

  cbdb.collection(RECORDS_COL).watch({
    onChange: snapshot => {
      records = snapshot.docs.map(d => ({ ...d, id: d._id }));
      if (currentView === 'home') renderHome();
      if (currentView === 'stats') renderStats();
    },
    onError: err => reportError('云端数据同步', err)
  });
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------
let coaches = [];
let records = [];
let currentView = 'home';
let selectedCoachId = null;
let currentNature = 'trial';   // trial | formal
let currentForm = 'group';     // group | private
let editingId = null;
let statsMode = 'month';       // month | custom
let exportContent = 'summary'; // summary | full
let exportPreset = null;       // 'thisMonth' | 'lastMonth' | null(自定义)
let openDetailCoachId = null;  // 统计页当前展开明细的教练
let coachManageOpen = false;   // 录课页“管理教练”折叠状态

const NATURE_LABEL = { trial: '体验课', formal: '正式课程' };
const FORM_LABEL = { group: '小班课', private: '私教课' };

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayStr() { return isoDate(new Date()); }
function monthRangeOf(year, monthIdx0) {
  const start = new Date(year, monthIdx0, 1);
  const end = new Date(year, monthIdx0 + 1, 0);
  return { start: isoDate(start), end: isoDate(end) };
}
function thisMonthRange() { const n = new Date(); return monthRangeOf(n.getFullYear(), n.getMonth()); }
function lastMonthRange() { const n = new Date(); return monthRangeOf(n.getFullYear(), n.getMonth() - 1); }
function coachName(id) { const c = coaches.find(c => c.id === id); return c ? c.name : '（未知教练）'; }
function fmtNum(n) { return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100); }

let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('appToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'appToast';
    Object.assign(el.style, {
      position: 'fixed', left: '50%', bottom: 'calc(76px + env(safe-area-inset-bottom, 0px))',
      transform: 'translateX(-50%)', background: 'rgba(119,85,55,0.94)', color: '#F1F1F1',
      padding: '10px 18px', borderRadius: '999px', fontSize: '13.5px', zIndex: 999,
      opacity: '0', transition: 'opacity .2s', pointerEvents: 'none', whiteSpace: 'nowrap'
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
}

// ---------------------------------------------------------------------------
// 统计计算：给定时间范围与记录，按教练汇总
// ---------------------------------------------------------------------------
function computeSummary(startDate, endDate, coachIds) {
  const inRange = records.filter(r => r.date >= startDate && r.date <= endDate && coachIds.includes(r.coachId));
  const result = {};
  coachIds.forEach(id => {
    result[id] = { trialGroup: 0, trialPrivate: 0, formalGroup: 0, formalPrivate: 0 };
  });
  inRange.forEach(r => {
    const bucket = result[r.coachId];
    if (!bucket) return;
    if (r.form === 'group') {
      if (r.nature === 'trial') bucket.trialGroup += (r.headcount || 0);
      else bucket.formalGroup += (r.headcount || 0);
    } else {
      if (r.nature === 'trial') bucket.trialPrivate += (r.hours || 0);
      else bucket.formalPrivate += (r.hours || 0);
    }
  });
  return result;
}

// 私教课按时长（1h / 1.5h / 2h / 其他）分别统计节次，用于首页拆分展示
function computePrivateDurationBreakdown(startDate, endDate, coachIds) {
  const inRange = records.filter(r => r.form === 'private' && r.date >= startDate && r.date <= endDate && coachIds.includes(r.coachId));
  const result = {};
  coachIds.forEach(id => { result[id] = { h1: 0, h15: 0, h2: 0, other: 0 }; });
  inRange.forEach(r => {
    const bucket = result[r.coachId];
    if (!bucket) return;
    const h = r.hours || 0;
    if (Math.abs(h - 1) < 1e-6) bucket.h1++;
    else if (Math.abs(h - 1.5) < 1e-6) bucket.h15++;
    else if (Math.abs(h - 2) < 1e-6) bucket.h2++;
    else bucket.other++;
  });
  return result;
}

// ---------------------------------------------------------------------------
// 视图切换（首页 / 录课 / 统计）
// ---------------------------------------------------------------------------
function switchView(view, opts) {
  opts = opts || {};
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));

  const titles = { home: '今日概览', entry: opts.editing ? '编辑记录' : '录入课程', stats: '统计查看' };
  document.getElementById('pageTitle').textContent = titles[view] || '';

  if (view === 'entry' && !opts.editing) resetEntryForNew();
  if (view === 'entry') renderCoaches();
  if (view === 'home') renderHome();
  if (view === 'stats') renderStats();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ---------------------------------------------------------------------------
// 首页
// ---------------------------------------------------------------------------
const coachOverviewList = document.getElementById('coachOverviewList');

function renderHome() {
  const { start, end } = thisMonthRange();
  const activeIds = coaches.map(c => c.id);
  const summary = computeSummary(start, end, activeIds);
  const durBreak = computePrivateDurationBreakdown(start, end, activeIds);
  let headcountSum = 0, hoursSum = 0;
  Object.values(summary).forEach(s => {
    headcountSum += s.trialGroup + s.formalGroup;
    hoursSum += s.trialPrivate + s.formalPrivate;
  });
  let durTotals = { h1: 0, h15: 0, h2: 0, other: 0 };
  Object.values(durBreak).forEach(d => {
    durTotals.h1 += d.h1; durTotals.h15 += d.h15; durTotals.h2 += d.h2; durTotals.other += d.other;
  });

  document.getElementById('homeStatCards').innerHTML = `
    <div class="stat-card"><div class="num">${fmtNum(headcountSum)}</div><div class="lbl">本月小班人次</div></div>
    <div class="stat-card"><div class="num">${fmtNum(hoursSum)}</div><div class="lbl">本月私教时长(h)</div></div>
  `;

  document.getElementById('homeDurationCards').innerHTML = `
    <div class="stat-card"><div class="num">${fmtNum(durTotals.h1)}</div><div class="lbl">私教1h 节次</div></div>
    <div class="stat-card"><div class="num">${fmtNum(durTotals.h15)}</div><div class="lbl">私教1.5h 节次</div></div>
    <div class="stat-card"><div class="num">${fmtNum(durTotals.h2)}</div><div class="lbl">私教2h 节次</div></div>
  ` + (durTotals.other > 0 ? `<div class="stat-card"><div class="num">${fmtNum(durTotals.other)}</div><div class="lbl">私教其他时长 节次</div></div>` : '');

  // 本月教练概况
  if (coaches.length === 0) {
    coachOverviewList.innerHTML = `<p class="empty-hint">还没有教练，去"录课"页添加第一位吧</p>`;
  } else {
    coachOverviewList.innerHTML = coaches.map(c => {
      const s = summary[c.id] || { trialGroup: 0, trialPrivate: 0, formalGroup: 0, formalPrivate: 0 };
      const d = durBreak[c.id] || { h1: 0, h15: 0, h2: 0, other: 0 };
      const groupSum = s.trialGroup + s.formalGroup;
      const privateSum = s.trialPrivate + s.formalPrivate;
      const durParts = [];
      if (d.h1) durParts.push(`1h×${fmtNum(d.h1)}`);
      if (d.h15) durParts.push(`1.5h×${fmtNum(d.h15)}`);
      if (d.h2) durParts.push(`2h×${fmtNum(d.h2)}`);
      if (d.other) durParts.push(`其他×${fmtNum(d.other)}`);
      const durLine = durParts.length ? `<div class="co-duration">${durParts.join(' · ')}</div>` : '';
      return `
        <div class="coach-overview-item" data-id="${c.id}">
          <div class="co-main">
            <span class="co-name">${c.name}${c.status === 'disabled' ? '（已停用）' : ''}</span>
            ${durLine}
          </div>
          <span class="co-metrics"><span>小班 <b>${fmtNum(groupSum)}</b> 人次</span><span>私教 <b>${fmtNum(privateSum)}</b> h</span></span>
        </div>`;
    }).join('');
    coachOverviewList.querySelectorAll('.coach-overview-item').forEach(el => {
      el.addEventListener('click', () => {
        openDetailCoachId = el.dataset.id;
        switchView('stats');
      });
    });
  }

  const today = todayStr();
  const todays = records.filter(r => r.date === today).sort((a, b) => b.createdAt - a.createdAt);
  const listEl = document.getElementById('todayList');
  if (todays.length === 0) {
    listEl.innerHTML = `<p class="empty-hint">今天还没有录入课程 — 点"＋ 记一笔"开始记录</p>`;
  } else {
    listEl.innerHTML = todays.map(r => recordItemHTML(r)).join('');
    listEl.querySelectorAll('.record-item').forEach(el => {
      el.addEventListener('click', () => {
        const rec = records.find(r => r.id === el.dataset.id);
        if (rec) enterEditMode(rec);
      });
    });
  }
}

function recordItemHTML(r) {
  const valueText = r.form === 'group' ? `${fmtNum(r.headcount)} 人次` : `${fmtNum(r.hours)} h`;
  return `
    <div class="record-item" data-id="${r.id}">
      <div class="ri-main">
        <span class="ri-coach">${coachName(r.coachId)}</span>
        <span class="ri-meta">${r.date} · ${NATURE_LABEL[r.nature]} · ${FORM_LABEL[r.form]}${r.note ? ' · ' + r.note : ''}</span>
      </div>
      <span class="ri-value">${valueText}</span>
    </div>`;
}

document.getElementById('quickEntryBtn').addEventListener('click', () => switchView('entry'));
document.getElementById('quickExportBtn').addEventListener('click', () => openExportModal());

// ---------------------------------------------------------------------------
// 录课页
// ---------------------------------------------------------------------------
const entryForm = document.getElementById('entryForm');
const coachSelect = document.getElementById('coachSelect');
const noCoachHint = document.getElementById('noCoachHint');
const dateInput = document.getElementById('dateInput');
const natureToggle = document.getElementById('natureToggle');
const formToggle = document.getElementById('formToggle');
const groupField = document.getElementById('groupField');
const privateField = document.getElementById('privateField');
const headcountInput = document.getElementById('headcountInput');
const durationInput = document.getElementById('durationInput');
const noteInput = document.getElementById('noteInput');
const editingIdInput = document.getElementById('editingId');
const deleteRecordBtn = document.getElementById('deleteRecordBtn');
const submitEntryBtn = document.getElementById('submitEntryBtn');

function renderCoachSelect(includeCoachId) {
  const list = coaches.filter(c => c.status === 'active' || c.id === includeCoachId);
  if (list.length === 0) {
    coachSelect.innerHTML = '<option value="">请选择教练</option>';
    coachSelect.disabled = true;
    noCoachHint.style.display = 'block';
    return;
  }
  coachSelect.disabled = false;
  noCoachHint.style.display = 'none';
  const options = ['<option value="">请选择教练</option>'].concat(
    list.map(c => `<option value="${c.id}">${c.name}${c.status === 'disabled' ? '（已停用）' : ''}</option>`)
  );
  coachSelect.innerHTML = options.join('');
  coachSelect.value = selectedCoachId || '';
}

coachSelect.addEventListener('change', () => {
  selectedCoachId = coachSelect.value || null;
});

function setToggle(container, value) {
  container.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.value === value));
}

natureToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-btn'); if (!btn) return;
  currentNature = btn.dataset.value;
  setToggle(natureToggle, currentNature);
});
formToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-btn'); if (!btn) return;
  currentForm = btn.dataset.value;
  setToggle(formToggle, currentForm);
  groupField.style.display = currentForm === 'group' ? 'block' : 'none';
  privateField.style.display = currentForm === 'private' ? 'block' : 'none';
});

entryForm.querySelectorAll('[data-step]').forEach(btn => {
  btn.addEventListener('click', () => {
    const step = Number(btn.dataset.step);
    const v = Math.max(0, (parseInt(headcountInput.value, 10) || 0) + step);
    headcountInput.value = v;
  });
});
entryForm.querySelectorAll('[data-hstep]').forEach(btn => {
  btn.addEventListener('click', () => {
    const step = Number(btn.dataset.hstep);
    const v = Math.max(0.5, Math.round(((parseFloat(durationInput.value) || 0) + step) * 10) / 10);
    durationInput.value = v;
  });
});
privateField.querySelectorAll('.quick-chip[data-hour]').forEach(btn => {
  btn.addEventListener('click', () => { durationInput.value = btn.dataset.hour; });
});

function resetEntryForNew() {
  editingId = null;
  editingIdInput.value = '';
  dateInput.value = todayStr();
  headcountInput.value = 1;
  durationInput.value = 1;
  noteInput.value = '';
  deleteRecordBtn.style.display = 'none';
  submitEntryBtn.textContent = '保存记录';
  setToggle(natureToggle, currentNature);
  setToggle(formToggle, currentForm);
  groupField.style.display = currentForm === 'group' ? 'block' : 'none';
  privateField.style.display = currentForm === 'private' ? 'block' : 'none';
  renderCoachSelect();
}

function enterEditMode(rec) {
  editingId = rec.id;
  editingIdInput.value = rec.id;
  selectedCoachId = rec.coachId;
  dateInput.value = rec.date;
  currentNature = rec.nature;
  currentForm = rec.form;
  setToggle(natureToggle, currentNature);
  setToggle(formToggle, currentForm);
  groupField.style.display = currentForm === 'group' ? 'block' : 'none';
  privateField.style.display = currentForm === 'private' ? 'block' : 'none';
  headcountInput.value = rec.headcount || 1;
  durationInput.value = rec.hours || 1;
  noteInput.value = rec.note || '';
  deleteRecordBtn.style.display = 'block';
  submitEntryBtn.textContent = '更新记录';
  renderCoachSelect(rec.coachId);
  switchView('entry', { editing: true });
}

entryForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!selectedCoachId) { toast('请先选择教练'); return; }
  if (!dateInput.value) { toast('请选择日期'); return; }

  const rec = {
    coachId: selectedCoachId,
    date: dateInput.value,
    nature: currentNature,
    form: currentForm,
    headcount: currentForm === 'group' ? (parseInt(headcountInput.value, 10) || 0) : null,
    hours: currentForm === 'private' ? (parseFloat(durationInput.value) || 0) : null,
    note: noteInput.value.trim()
  };

  // 不等待云端写入完成再刷新界面：断网时也能立即记录，联网后自动补传同步
  if (editingId) {
    rec.id = editingId;
    DB.updateRecord(rec).catch(err => reportError('更新记录', err));
    toast('已更新');
    switchView('home');
  } else {
    DB.addRecord(rec).catch(err => reportError('保存记录', err));
    toast('已保存，可继续录入');
    headcountInput.value = 1;
    durationInput.value = 1;
    noteInput.value = '';
  }
});

deleteRecordBtn.addEventListener('click', () => {
  if (!editingId) return;
  if (!confirm('确定删除这条记录？删除后无法恢复。')) return;
  DB.deleteRecord(editingId).catch(err => reportError('删除记录', err));
  toast('已删除');
  switchView('home');
});

// ---- 录课页内的教练管理（可折叠） ----
const toggleCoachManageBtn = document.getElementById('toggleCoachManageBtn');
const coachManagePanel = document.getElementById('coachManagePanel');
const coachManageArrow = document.getElementById('coachManageArrow');
const newCoachName = document.getElementById('newCoachName');
const addCoachBtn = document.getElementById('addCoachBtn');
const coachListEl = document.getElementById('coachList');

toggleCoachManageBtn.addEventListener('click', () => {
  coachManageOpen = !coachManageOpen;
  coachManagePanel.style.display = coachManageOpen ? 'block' : 'none';
  coachManageArrow.textContent = coachManageOpen ? '▴' : '▾';
});

addCoachBtn.addEventListener('click', () => {
  const name = newCoachName.value.trim();
  if (!name) { toast('请输入教练姓名'); return; }
  DB.addCoach(name).catch(err => reportError('添加教练', err));
  newCoachName.value = '';
  toast('已添加教练');
});
newCoachName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCoachBtn.click(); } });

function renderCoaches() {
  if (coaches.length === 0) {
    coachListEl.innerHTML = `<p class="empty-hint">还没有教练，先在上方添加第一位吧</p>`;
    return;
  }
  coachListEl.innerHTML = coaches.map(c => `
    <div class="coach-item" data-id="${c.id}">
      <div class="ci-top">
        <span class="ci-name">${c.name}</span>
        <span class="ci-status ${c.status}">${c.status === 'active' ? '在职' : '停用'}</span>
      </div>
      <div class="ci-actions">
        <button data-action="rename">改名</button>
        <button data-action="toggle">${c.status === 'active' ? '停用' : '启用'}</button>
        <button data-action="delete" class="ci-danger">删除</button>
      </div>
    </div>`).join('');

  coachListEl.querySelectorAll('[data-action="rename"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.coach-item').dataset.id;
      const c = coaches.find(c => c.id === id);
      const name = prompt('修改教练姓名', c.name);
      if (name && name.trim()) {
        c.name = name.trim();
        DB.updateCoach(c).catch(err => reportError('修改教练', err));
        toast('已更新');
      }
    });
  });
  coachListEl.querySelectorAll('[data-action="toggle"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.coach-item').dataset.id;
      const c = coaches.find(c => c.id === id);
      c.status = c.status === 'active' ? 'disabled' : 'active';
      DB.updateCoach(c).catch(err => reportError('修改教练状态', err));
      toast(c.status === 'active' ? '已启用' : '已停用（历史数据保留）');
    });
  });
  coachListEl.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.coach-item').dataset.id;
      const c = coaches.find(c => c.id === id);
      const recordCount = records.filter(r => r.coachId === id).length;
      if (recordCount > 0) {
        alert(`"${c.name}" 名下还有 ${recordCount} 条课程记录，为避免统计数据错乱，暂不支持直接删除。\n如果这位教练已经离职，建议用"停用"，可以保留历史统计数据。`);
        return;
      }
      if (!confirm(`确定删除教练"${c.name}"？该教练目前没有任何课程记录，删除后无法恢复。`)) return;
      DB.deleteCoach(id).catch(err => reportError('删除教练', err));
      toast('已删除');
    });
  });
}

// ---------------------------------------------------------------------------
// 统计查看页
// ---------------------------------------------------------------------------
const rangeModeToggle = document.getElementById('rangeModeToggle');
const monthPickWrap = document.getElementById('monthPickWrap');
const customPickWrap = document.getElementById('customPickWrap');
const statsMonth = document.getElementById('statsMonth');
const statsStart = document.getElementById('statsStart');
const statsEnd = document.getElementById('statsEnd');
const statsTableWrap = document.getElementById('statsTableWrap');

rangeModeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-btn'); if (!btn) return;
  statsMode = btn.dataset.mode;
  setToggle(rangeModeToggle, statsMode);
  monthPickWrap.style.display = statsMode === 'month' ? 'block' : 'none';
  customPickWrap.style.display = statsMode === 'custom' ? 'block' : 'none';
  renderStats();
});
statsMonth.addEventListener('change', renderStats);
statsStart.addEventListener('change', renderStats);
statsEnd.addEventListener('change', renderStats);

function currentStatsRange() {
  if (statsMode === 'month') {
    const [y, m] = (statsMonth.value || todayStr().slice(0, 7)).split('-').map(Number);
    return monthRangeOf(y, m - 1);
  }
  return { start: statsStart.value || thisMonthRange().start, end: statsEnd.value || thisMonthRange().end };
}

function renderStats() {
  if (!statsMonth.value) statsMonth.value = todayStr().slice(0, 7);
  if (!statsStart.value || !statsEnd.value) {
    const { start, end } = thisMonthRange();
    statsStart.value = statsStart.value || start;
    statsEnd.value = statsEnd.value || end;
  }
  const { start, end } = currentStatsRange();
  if (coaches.length === 0) {
    statsTableWrap.innerHTML = `<p class="empty-hint">还没有教练，先去"录课"页添加</p>`;
    return;
  }
  const ids = coaches.map(c => c.id);
  const summary = computeSummary(start, end, ids);

  let rows = '';
  let totals = { trialGroup: 0, trialPrivate: 0, formalGroup: 0, formalPrivate: 0, groupSum: 0, privateSum: 0 };

  coaches.forEach(c => {
    const s = summary[c.id];
    const groupSum = s.trialGroup + s.formalGroup;
    const privateSum = s.trialPrivate + s.formalPrivate;
    totals.trialGroup += s.trialGroup; totals.trialPrivate += s.trialPrivate;
    totals.formalGroup += s.formalGroup; totals.formalPrivate += s.formalPrivate;
    totals.groupSum += groupSum; totals.privateSum += privateSum;

    const isOpen = openDetailCoachId === c.id;
    rows += `
      <tr class="stats-row" data-id="${c.id}">
        <td class="coach-name">${c.name}</td>
        <td>${fmtNum(s.trialGroup)}</td>
        <td>${fmtNum(s.trialPrivate)}</td>
        <td>${fmtNum(s.formalGroup)}</td>
        <td>${fmtNum(s.formalPrivate)}</td>
        <td><b>${fmtNum(groupSum)}</b></td>
        <td><b>${fmtNum(privateSum)}</b></td>
      </tr>
      <tr class="detail-row" style="display:${isOpen ? 'table-row' : 'none'}">
        <td colspan="7">${renderDetailPanel(c.id, start, end)}</td>
      </tr>`;
  });

  statsTableWrap.innerHTML = `
    <div class="table-scroll">
      <table class="stats-table">
        <thead>
          <tr>
            <th>教练</th><th>体验<br>小班人次</th><th>体验<br>私教h</th>
            <th>正式<br>小班人次</th><th>正式<br>私教h</th><th>小班<br>合计</th><th>私教<br>合计h</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td>合计</td>
            <td>${fmtNum(totals.trialGroup)}</td><td>${fmtNum(totals.trialPrivate)}</td>
            <td>${fmtNum(totals.formalGroup)}</td><td>${fmtNum(totals.formalPrivate)}</td>
            <td>${fmtNum(totals.groupSum)}</td><td>${fmtNum(totals.privateSum)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="empty-hint" style="padding-top:10px">点击教练行可展开当期逐条记录，支持编辑/删除</p>
  `;

  statsTableWrap.querySelectorAll('.stats-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      openDetailCoachId = openDetailCoachId === id ? null : id;
      renderStats();
    });
  });
  statsTableWrap.querySelectorAll('[data-edit-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rec = records.find(r => r.id === btn.dataset.editId);
      if (rec) enterEditMode(rec);
    });
  });
  statsTableWrap.querySelectorAll('[data-del-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('确定删除这条记录？')) return;
      DB.deleteRecord(btn.dataset.delId).catch(err => reportError('删除记录', err));
      toast('已删除');
    });
  });

  if (openDetailCoachId) {
    const row = statsTableWrap.querySelector(`.stats-row[data-id="${openDetailCoachId}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

function renderDetailPanel(coachId, start, end) {
  const list = records.filter(r => r.coachId === coachId && r.date >= start && r.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (list.length === 0) return `<div class="detail-panel">该时间段暂无记录</div>`;
  const rowsHtml = list.map(r => {
    const val = r.form === 'group' ? `${fmtNum(r.headcount)}人次` : `${fmtNum(r.hours)}h`;
    return `<div class="dp-row">
      <span>${r.date} · ${NATURE_LABEL[r.nature]}·${FORM_LABEL[r.form]}${r.note ? '（' + r.note + '）' : ''}</span>
      <span>
        <b>${val}</b>
        <button data-edit-id="${r.id}" style="margin-left:8px;border:none;background:none;color:#775537;font-weight:700;">编辑</button>
        <button data-del-id="${r.id}" style="border:none;background:none;color:#C4453D;font-weight:700;">删除</button>
      </span>
    </div>`;
  }).join('');
  return `<div class="detail-panel">${rowsHtml}</div>`;
}

// ---------------------------------------------------------------------------
// 导出弹窗（可从首页或统计页打开）
// ---------------------------------------------------------------------------
const exportModal = document.getElementById('exportModal');
const openExportBtn = document.getElementById('openExportBtn');
const closeExportBtn = document.getElementById('closeExportBtn');
const exportStart = document.getElementById('exportStart');
const exportEnd = document.getElementById('exportEnd');
const exportCoachChecks = document.getElementById('exportCoachChecks');
const exportContentToggle = document.getElementById('exportContentToggle');
const exportBtn = document.getElementById('exportBtn');
const exportHint = document.getElementById('exportHint');

openExportBtn.addEventListener('click', () => openExportModal());
closeExportBtn.addEventListener('click', () => { exportModal.style.display = 'none'; });
exportModal.addEventListener('click', (e) => { if (e.target === exportModal) exportModal.style.display = 'none'; });

function openExportModal() {
  if (!exportStart.value || !exportEnd.value) {
    const r = thisMonthRange();
    exportStart.value = r.start;
    exportEnd.value = r.end;
    exportPreset = 'thisMonth';
  }
  exportHint.textContent = '';
  renderExportCoachChecks();
  document.querySelectorAll('#exportModal .quick-chip').forEach(b => b.classList.toggle('active', b.dataset.range === exportPreset));
  setToggle(exportContentToggle, exportContent);
  exportModal.style.display = 'flex';
}

document.querySelectorAll('#exportModal .quick-chip[data-range]').forEach(btn => {
  btn.addEventListener('click', () => {
    const range = btn.dataset.range;
    exportPreset = range;
    const r = range === 'thisMonth' ? thisMonthRange() : lastMonthRange();
    exportStart.value = r.start;
    exportEnd.value = r.end;
    document.querySelectorAll('#exportModal .quick-chip[data-range]').forEach(b => b.classList.toggle('active', b === btn));
  });
});
exportStart.addEventListener('change', () => { exportPreset = null; document.querySelectorAll('#exportModal .quick-chip[data-range]').forEach(b => b.classList.remove('active')); });
exportEnd.addEventListener('change', () => { exportPreset = null; document.querySelectorAll('#exportModal .quick-chip[data-range]').forEach(b => b.classList.remove('active')); });

exportContentToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-btn'); if (!btn) return;
  exportContent = btn.dataset.value;
  setToggle(exportContentToggle, exportContent);
});

function renderExportCoachChecks() {
  if (coaches.length === 0) {
    exportCoachChecks.innerHTML = `<p class="empty-hint">还没有教练</p>`;
    return;
  }
  exportCoachChecks.innerHTML = coaches.map(c => `
    <label class="check-item">
      <input type="checkbox" value="${c.id}" checked>
      <span>${c.name}${c.status === 'disabled' ? '（已停用）' : ''}</span>
    </label>`).join('');
}

exportBtn.addEventListener('click', () => {
  if (typeof XLSX === 'undefined') { toast('导出组件加载失败，请检查网络后重试'); return; }
  const start = exportStart.value, end = exportEnd.value;
  if (!start || !end) { toast('请选择导出时间段'); return; }
  if (start > end) { toast('起始日期不能晚于结束日期'); return; }
  const checked = Array.from(exportCoachChecks.querySelectorAll('input[type=checkbox]:checked')).map(i => i.value);
  if (checked.length === 0) { toast('请至少选择一位教练'); return; }

  const selectedCoaches = coaches.filter(c => checked.includes(c.id));
  const summary = computeSummary(start, end, checked);

  const summaryAOA = [
    [`月度汇总  ${start} 至 ${end}`],
    ['教练', '体验-小班人次', '体验-私教时长(h)', '正式-小班人次', '正式-私教时长(h)', '小班合计人次', '私教合计时长(h)']
  ];
  let tot = { tg: 0, tp: 0, fg: 0, fp: 0, gs: 0, ps: 0 };
  selectedCoaches.forEach(c => {
    const s = summary[c.id];
    const groupSum = s.trialGroup + s.formalGroup;
    const privateSum = s.trialPrivate + s.formalPrivate;
    tot.tg += s.trialGroup; tot.tp += s.trialPrivate; tot.fg += s.formalGroup; tot.fp += s.formalPrivate;
    tot.gs += groupSum; tot.ps += privateSum;
    summaryAOA.push([c.name, s.trialGroup, s.trialPrivate, s.formalGroup, s.formalPrivate, groupSum, privateSum]);
  });
  summaryAOA.push(['合计', tot.tg, tot.tp, tot.fg, tot.fp, tot.gs, tot.ps]);

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(summaryAOA);
  ws1['!cols'] = [{ wch: 12 }, { wch: 15 }, { wch: 16 }, { wch: 15 }, { wch: 16 }, { wch: 14 }, { wch: 15 }];
  ws1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
  XLSX.utils.book_append_sheet(wb, ws1, '月度汇总');

  if (exportContent === 'full') {
    const detailAOA = [['日期', '教练', '课程性质', '课程形式', '人次(小班课)', '时长-小时(私教课)', '备注']];
    records.filter(r => r.date >= start && r.date <= end && checked.includes(r.coachId))
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach(r => {
        detailAOA.push([
          r.date, coachName(r.coachId), NATURE_LABEL[r.nature], FORM_LABEL[r.form],
          r.form === 'group' ? r.headcount : '', r.form === 'private' ? r.hours : '', r.note || ''
        ]);
      });
    const ws2 = XLSX.utils.aoa_to_sheet(detailAOA);
    ws2['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 18 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, ws2, '明细记录');
  }

  const filename = `课时统计_${start}_至_${end}.xlsx`;
  XLSX.writeFile(wb, filename);
  exportHint.textContent = `已导出 ${start} 至 ${end}，共 ${selectedCoaches.length} 位教练的数据`;
  toast('导出成功');
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
async function init() {
  dateInput.value = todayStr();
  resetEntryForNew();
  renderHome();
  const { error } = await cbAuth.signInAnonymously();
  if (error) {
    reportError('云端登录', error);
    return;
  }
  startRealtimeSync();
}
init();
