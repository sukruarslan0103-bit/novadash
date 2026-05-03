/* ============================================================
   TASKS VIEW — Tüm Görevler (tab: Takvim + Liste)
   Veri kaynağı: localStorage 'calendar_tasks'
   ============================================================ */

(function () {
    'use strict';

    var STORAGE_KEY = 'calendar_tasks';
    var MONTH_NAMES = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

    var _state = {
        status: 'all',       // all | pending | done | overdue
        priority: 'all',     // all | 1 | 2 | 3
        category: 'all',
        datePreset: 'all',   // all | today | week | month | custom
        customFrom: '',
        customTo: ''
    };

    var _activeTab = 'calendar'; // 'calendar' | 'list'

    // ---------- utils ----------
    function loadTasks() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function saveTasks(list) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list || [])); } catch (e) {}
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function pad2(n){ return String(n).padStart(2,'0'); }
    function todayISO() {
        var d = new Date();
        return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
    }
    function addDaysISO(iso, delta) {
        var p = iso.split('-');
        var d = new Date(Number(p[0]), Number(p[1])-1, Number(p[2]));
        d.setDate(d.getDate()+delta);
        return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
    }
    function startOfWeekISO() {
        var d = new Date();
        var dow = (d.getDay()+6)%7;
        d.setDate(d.getDate()-dow);
        return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
    }
    function endOfWeekISO(){ return addDaysISO(startOfWeekISO(), 6); }
    function startOfMonthISO(){
        var d = new Date();
        return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-01';
    }
    function endOfMonthISO(){
        var d = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0);
        return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
    }
    function normalizeCategory(raw) {
        if (!raw) return '';
        var s = String(raw).trim();
        if (!s) return '';
        var lower = s.toLocaleLowerCase('tr-TR');
        return lower.charAt(0).toLocaleUpperCase('tr-TR') + lower.slice(1);
    }
    function prettyDate(iso) {
        if (!iso) return '';
        var p = iso.split('-');
        return Number(p[2])+' '+MONTH_NAMES[Number(p[1])-1]+' '+p[0];
    }
    function getDateRange() {
        var today = todayISO();
        switch (_state.datePreset) {
            case 'today': return { from: today, to: today };
            case 'week':  return { from: startOfWeekISO(), to: endOfWeekISO() };
            case 'month': return { from: startOfMonthISO(), to: endOfMonthISO() };
            case 'custom':
                if (!_state.customFrom && !_state.customTo) return null;
                return {
                    from: _state.customFrom || '0000-01-01',
                    to:   _state.customTo   || '9999-12-31'
                };
            default: return null;
        }
    }
    function getUniqueCategories(tasks) {
        var set = {};
        for (var i=0;i<tasks.length;i++) {
            var c = normalizeCategory(tasks[i] && tasks[i].category);
            if (c) set[c] = true;
        }
        return Object.keys(set).sort(function(a,b){ return a.localeCompare(b,'tr'); });
    }

    // ---------- filter + sort ----------
    function applyFilters(tasks) {
        var today = todayISO();
        var range = getDateRange();
        return tasks.filter(function(t) {
            if (!t) return false;
            var isOverdue = !t.is_done && t.date && t.date < today;
            if (_state.status === 'pending' && t.is_done) return false;
            if (_state.status === 'done' && !t.is_done) return false;
            if (_state.status === 'overdue' && !isOverdue) return false;
            if (_state.priority !== 'all' && Number(t.priority) !== Number(_state.priority)) return false;
            if (_state.category !== 'all' && normalizeCategory(t.category) !== _state.category) return false;
            if (range) {
                if (!t.date) return false;
                if (t.date < range.from || t.date > range.to) return false;
            }
            return true;
        });
    }
    function sortTasks(tasks) {
        var today = todayISO();
        return tasks.slice().sort(function(a,b) {
            var ao = !a.is_done && a.date && a.date < today ? 1 : 0;
            var bo = !b.is_done && b.date && b.date < today ? 1 : 0;
            if (ao !== bo) return bo - ao;
            var ap = Number(a.priority)||0;
            var bp = Number(b.priority)||0;
            if (ap !== bp) return bp - ap;
            return String(a.date||'').localeCompare(String(b.date||''));
        });
    }

    // ---------- render helpers ----------
    function selectBox(id, label, options, current) {
        var opts = options.map(function(o){
            var sel = String(o.value)===String(current) ? ' selected' : '';
            return '<option value="'+esc(o.value)+'"'+sel+'>'+esc(o.label)+'</option>';
        }).join('');
        return '<div style="display:flex;flex-direction:column;gap:4px;min-width:140px;">' +
            '<label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">'+label+'</label>' +
            '<select id="'+id+'" style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;background:#fff;color:#0f172a;font-weight:600;cursor:pointer;">'+opts+'</select>' +
        '</div>';
    }

    function priorityBadge(p) {
        var n = Number(p)||1;
        var color, bg, label;
        if (n>=3)       { color='#991b1b'; bg='#fee2e2'; label='★★★'; }
        else if (n===2) { color='#9a3412'; bg='#ffedd5'; label='★★';  }
        else            { color='#1e40af'; bg='#dbeafe'; label='★';   }
        return '<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;background:'+bg+';color:'+color+';font-size:11px;font-weight:800;">'+label+'</span>';
    }
    function statusBadge(t, todayK) {
        if (t.is_done) return '<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;background:#dcfce7;color:#166534;font-size:11px;font-weight:800;">✓ Tamamlandı</span>';
        if (t.date && t.date < todayK) return '<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;background:#dc2626;color:#fff;font-size:11px;font-weight:800;letter-spacing:0.04em;">⚠ GECİKTİ</span>';
        return '<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;background:#e0e7ff;color:#3730a3;font-size:11px;font-weight:800;">Bekliyor</span>';
    }

    function renderFilterBar(root) {
        var bar = root.querySelector('#tvFilterBar');
        if (!bar) return;
        var cats = getUniqueCategories(loadTasks());

        var statusOpts = [
            { value:'all', label:'Tümü' },
            { value:'pending', label:'Bekleyen' },
            { value:'done', label:'Tamamlanan' },
            { value:'overdue', label:'Geciken' }
        ];
        var prioOpts = [
            { value:'all', label:'Tümü' },
            { value:'3', label:'★★★ Yüksek' },
            { value:'2', label:'★★ Orta' },
            { value:'1', label:'★ Düşük' }
        ];
        var catOpts = [{ value:'all', label:'Tümü' }].concat(cats.map(function(c){ return {value:c,label:c}; }));
        var dateOpts = [
            { value:'all', label:'Tümü' },
            { value:'today', label:'Bugün' },
            { value:'week', label:'Bu Hafta' },
            { value:'month', label:'Bu Ay' },
            { value:'custom', label:'Özel Aralık' }
        ];

        var customHtml = '';
        if (_state.datePreset === 'custom') {
            customHtml =
                '<div style="display:flex;flex-direction:column;gap:4px;">' +
                    '<label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Başlangıç</label>' +
                    '<input id="tvCustomFrom" type="date" value="'+esc(_state.customFrom)+'" style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;" />' +
                '</div>' +
                '<div style="display:flex;flex-direction:column;gap:4px;">' +
                    '<label style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Bitiş</label>' +
                    '<input id="tvCustomTo" type="date" value="'+esc(_state.customTo)+'" style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;" />' +
                '</div>';
        }

        bar.innerHTML =
            '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;padding:16px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-bottom:18px;box-shadow:0 1px 2px rgba(15,23,42,0.04);">' +
                selectBox('tvStatus','Durum',statusOpts,_state.status) +
                selectBox('tvPriority','Öncelik',prioOpts,_state.priority) +
                selectBox('tvCategory','Kategori',catOpts,_state.category) +
                selectBox('tvDate','Tarih',dateOpts,_state.datePreset) +
                customHtml +
                '<button id="tvReset" type="button" style="padding:8px 14px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;font-weight:700;color:#475569;cursor:pointer;">Sıfırla</button>' +
            '</div>';

        var s = root.querySelector('#tvStatus');
        var p = root.querySelector('#tvPriority');
        var c = root.querySelector('#tvCategory');
        var d = root.querySelector('#tvDate');
        var rs = root.querySelector('#tvReset');
        if (s) s.addEventListener('change', function(){ _state.status=s.value; renderList(root); });
        if (p) p.addEventListener('change', function(){ _state.priority=p.value; renderList(root); });
        if (c) c.addEventListener('change', function(){ _state.category=c.value; renderList(root); });
        if (d) d.addEventListener('change', function(){
            _state.datePreset = d.value;
            renderFilterBar(root);
            renderList(root);
        });

        var cf = root.querySelector('#tvCustomFrom');
        var ct = root.querySelector('#tvCustomTo');
        if (cf) cf.addEventListener('change', function(){ _state.customFrom = cf.value; renderList(root); });
        if (ct) ct.addEventListener('change', function(){ _state.customTo   = ct.value; renderList(root); });

        if (rs) rs.addEventListener('click', function() {
            _state = { status:'all', priority:'all', category:'all', datePreset:'all', customFrom:'', customTo:'' };
            renderFilterBar(root);
            renderList(root);
        });
    }

    function refreshListTab(root) {
        renderFilterBar(root);
        renderList(root);
    }

    function renderList(root) {
        var listEl = root.querySelector('#tvList');
        var countEl = root.querySelector('#tvCount');
        if (!listEl) return;

        var todayK = todayISO();
        var filtered = applyFilters(loadTasks());
        var sorted = sortTasks(filtered);
        if (countEl) countEl.textContent = sorted.length + ' görev';

        if (!sorted.length) {
            listEl.innerHTML =
                '<div style="padding:48px;text-align:center;color:#94a3b8;font-size:14px;border:1px dashed #e5e7eb;border-radius:14px;background:#fff;">Görev bulunamadı</div>';
            return;
        }

        var html = sorted.map(function(t) {
            var isOverdue = !t.is_done && t.date && t.date < todayK;
            var catBadge = t.category
                ? '<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;background:#e0e7ff;color:#3730a3;font-size:11px;font-weight:700;">'+esc(t.category)+'</span>'
                : '';
            var finBadge = t.is_financial
                ? '<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;background:#dcfce7;color:#166534;font-size:11px;font-weight:700;">💰 Finansal</span>'
                : '';
            var border = isOverdue
                ? 'border:1px solid #e5e7eb;border-left:4px solid #dc2626;'
                : 'border:1px solid #e5e7eb;';
            var bg = t.is_done ? '#f8fafc' : '#fff';
            var titleColor = t.is_done ? '#94a3b8' : '#020617';
            var titleDeco = t.is_done ? 'text-decoration:line-through;' : '';

            var actionBtn = t.is_done
                ? '<button data-tv-undo="'+esc(t.id)+'" style="background:#f1f5f9;border:1px solid #e5e7eb;color:#334155;font-size:12px;font-weight:800;padding:8px 14px;border-radius:8px;cursor:pointer;">↺ Geri Al</button>'
                : '<button data-tv-done="'+esc(t.id)+'" style="background:#16a34a;border:1px solid #15803d;color:#fff;font-size:12px;font-weight:800;padding:8px 14px;border-radius:8px;cursor:pointer;box-shadow:0 1px 2px rgba(22,163,74,0.2);">✓ Tamamla</button>';

            return '<div style="padding:16px 18px;'+border+'border-radius:12px;background:'+bg+';margin-bottom:12px;display:flex;gap:14px;align-items:flex-start;box-shadow:0 1px 2px rgba(15,23,42,0.04);">' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">' +
                        statusBadge(t, todayK) +
                        priorityBadge(t.priority) +
                        catBadge +
                        finBadge +
                    '</div>' +
                    '<div style="font-size:15px;font-weight:800;color:'+titleColor+';letter-spacing:-0.005em;margin-bottom:4px;'+titleDeco+'">'+esc(t.title||'')+'</div>' +
                    (t.description
                        ? '<div style="font-size:13px;color:'+(t.is_done?'#94a3b8':'#334155')+';line-height:1.55;margin-bottom:6px;">'+esc(t.description)+'</div>'
                        : '') +
                    '<div style="font-size:12px;color:#64748b;font-weight:600;">📅 '+esc(prettyDate(t.date))+'</div>' +
                '</div>' +
                '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0;">' +
                    actionBtn +
                    '<button data-tv-del="'+esc(t.id)+'" style="background:transparent;border:none;color:#dc2626;cursor:pointer;font-size:18px;padding:2px 8px;">×</button>' +
                '</div>' +
            '</div>';
        }).join('');

        listEl.innerHTML = html;

        listEl.querySelectorAll('[data-tv-done]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = btn.getAttribute('data-tv-done');
                var list = loadTasks().map(function(x){
                    if (x.id===id){ x.is_done=true; x.done_at=new Date().toISOString(); }
                    return x;
                });
                saveTasks(list);
                refreshListTab(root);
            });
        });
        listEl.querySelectorAll('[data-tv-undo]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = btn.getAttribute('data-tv-undo');
                var list = loadTasks().map(function(x){
                    if (x.id===id){ x.is_done=false; delete x.done_at; }
                    return x;
                });
                saveTasks(list);
                refreshListTab(root);
            });
        });
        listEl.querySelectorAll('[data-tv-del]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var id = btn.getAttribute('data-tv-del');
                var list = loadTasks().filter(function(x){ return x.id!==id; });
                saveTasks(list);
                refreshListTab(root);
            });
        });
    }

    // ---------- tab system ----------
    function tabButton(key, label, active) {
        var bg = active ? 'linear-gradient(135deg,#4f46e5,#6366f1)' : 'transparent';
        var color = active ? '#fff' : '#475569';
        var shadow = active ? '0 2px 8px rgba(79,70,229,0.25)' : 'none';
        return '<button data-tv-tab="'+key+'" type="button" style="padding:10px 22px;border:none;border-radius:10px;background:'+bg+';color:'+color+';font-size:14px;font-weight:700;cursor:pointer;transition:all 0.15s ease;box-shadow:'+shadow+';">'+label+'</button>';
    }

    function renderTabBar(container) {
        var bar = container.querySelector('#tvTabBar');
        if (!bar) return;
        bar.innerHTML =
            '<div style="display:inline-flex;gap:6px;padding:4px;background:#f1f5f9;border-radius:12px;border:1px solid #e5e7eb;">' +
                tabButton('calendar', '📅 Takvim', _activeTab === 'calendar') +
                tabButton('list',     '📋 Liste',  _activeTab === 'list') +
            '</div>';
        bar.querySelectorAll('[data-tv-tab]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var next = btn.getAttribute('data-tv-tab');
                if (next === _activeTab) return;
                _activeTab = next;
                renderTabBar(container);
                renderTabContent(container);
            });
        });
    }

    function renderListTab(content) {
        content.innerHTML =
            '<div style="max-width:1100px;margin:0 auto;padding:0 20px 24px 20px;">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;gap:12px;flex-wrap:wrap;">' +
                    '<div>' +
                        '<h2 style="margin:0 0 4px 0;font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;">Tüm Görevler</h2>' +
                        '<p style="margin:0;font-size:13px;color:#64748b;">Filtrele, tamamla, sil.</p>' +
                    '</div>' +
                    '<div id="tvCount" style="font-size:13px;color:#475569;font-weight:700;background:#f1f5f9;padding:6px 12px;border-radius:999px;">0 görev</div>' +
                '</div>' +
                '<div id="tvFilterBar"></div>' +
                '<div id="tvList"></div>' +
            '</div>';
        renderFilterBar(content);
        renderList(content);
    }

    function renderTabContent(container) {
        var content = container.querySelector('#tvTabContent');
        if (!content) return;

        if (_activeTab === 'calendar') {
            if (window.CalendarView && typeof window.CalendarView.render === 'function') {
                content.innerHTML = '';
                window.CalendarView.render(content);
            } else {
                content.innerHTML = '<div style="padding:24px;color:#dc2626;font-weight:700;">CalendarView yüklenmedi</div>';
            }
        } else {
            renderListTab(content);
        }
    }

    // ---------- public render ----------
    window.TasksView = {
        render: function (container) {
            if(window.__DEBUG__)console.log('TasksView render çalıştı');
            if (!container) { console.error('TasksView: container yok'); return; }

            container.style.display = 'block';
            container.innerHTML =
                '<div style="background:#f7f8fa;min-height:100vh;">' +
                    '<div style="max-width:1400px;margin:0 auto;padding:20px;">' +
                        '<div id="tvTabBar" style="margin-bottom:20px;"></div>' +
                    '</div>' +
                    '<div id="tvTabContent"></div>' +
                '</div>';

            renderTabBar(container);
            renderTabContent(container);
        }
    };
})();
