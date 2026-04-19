/* ============================================================
   CALENDAR VIEW — Basit Görev Ekleme (localStorage)
   ============================================================ */

window.CalendarView = (function () {
    'use strict';

    var STORAGE_KEY = 'calendar_tasks';

    // Grid state
    var _viewState = { year: 0, month: 0, selectedDate: null }; // month: 0-11, selectedDate: YYYY-MM-DD
    var MONTH_NAMES = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
    var WEEK_DAYS = ['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'];

    function loadTasks() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    function saveTasks(list) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(list || []));
        } catch (e) { /* ignore */ }
    }

    // "BANKA" / "banka" / " Banka " → "Banka"
    function normalizeCategory(raw) {
        if (!raw) return '';
        var s = String(raw).trim();
        if (!s) return '';
        var lower = s.toLocaleLowerCase('tr-TR');
        return lower.charAt(0).toLocaleUpperCase('tr-TR') + lower.slice(1);
    }

    function getUniqueCategories(list) {
        var map = new Map();
        for (var i = 0; i < list.length; i++) {
            var c = normalizeCategory(list[i] && list[i].category);
            if (c && !map.has(c)) map.set(c, true);
        }
        return Array.from(map.keys()).sort(function (a, b) {
            return a.localeCompare(b, 'tr');
        });
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function todayISO() {
        var d = new Date();
        var m = String(d.getMonth() + 1).padStart(2, '0');
        var day = String(d.getDate()).padStart(2, '0');
        return d.getFullYear() + '-' + m + '-' + day;
    }

    function renderTaskList(container) {
        var allTasks = loadTasks();
        var listEl = container.querySelector('#cvTaskList');
        if (!listEl) return;

        var sel = _viewState.selectedDate;
        // Panelde sadece AKTİF (is_done=false) görevler — tamamlanınca anında kaybolsun
        var tasks = (sel
            ? allTasks.filter(function (t) { return t && t.date === sel; })
            : allTasks
        ).filter(function (t) { return !t.is_done; });

        // header: hangi gün gösteriliyor
        var headerHtml = '';
        if (sel) {
            var parts = sel.split('-');
            var prettyDate = Number(parts[2]) + ' ' + MONTH_NAMES[Number(parts[1]) - 1] + ' ' + parts[0];
            headerHtml =
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
                    '<div style="font-size:14px;font-weight:700;color:#0f172a;">' + prettyDate + ' · ' + tasks.length + ' görev</div>' +
                '</div>';
        }

        if (!tasks.length) {
            listEl.innerHTML = headerHtml +
                '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:13px;border:1px dashed #e2e8f0;border-radius:12px;">' +
                (sel ? 'Bu günde görev yok.' : 'Henüz görev yok. "+ Görev Ekle" butonuna tıkla.') +
                '</div>';
            return;
        }

        // tarihe göre azalan
        var sorted = tasks.slice().sort(function (a, b) {
            return String(b.date || '').localeCompare(String(a.date || ''));
        });

        var active = sorted; // artık list zaten aktiflerle filtrelendi
        var done   = [];

        function renderCard(t) {
            var stars = '★'.repeat(Math.max(1, Math.min(3, Number(t.priority) || 1)));
            var finBadge = t.is_financial
                ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;background:#dcfce7;color:#166534;font-size:11px;font-weight:700;">💰 Finansal</span>'
                : '';
            var cat = escapeHtml(t.category || '');
            var catBadge = cat
                ? '<span style="display:inline-flex;align-items:center;padding:3px 8px;border-radius:6px;background:#e0e7ff;color:#3730a3;font-size:11px;font-weight:700;">' + cat + '</span>'
                : '';

            var isDone = !!t.is_done;
            var cardBg = isDone ? '#f8fafc' : '#fff';
            var titleStyle = 'font-size:15px;font-weight:800;color:' + (isDone ? '#94a3b8' : '#020617') + ';margin-bottom:4px;letter-spacing:-0.005em;' + (isDone ? 'text-decoration:line-through;' : '');

            var actionBtn = isDone
                ? '<button data-cv-undo="' + escapeHtml(t.id) + '" style="background:#f1f5f9;border:1px solid #e5e7eb;color:#334155;cursor:pointer;font-size:12px;font-weight:800;padding:8px 14px;border-radius:8px;letter-spacing:0.01em;">↺ Geri Al</button>'
                : '<button data-cv-done="' + escapeHtml(t.id) + '" style="background:#16a34a;border:1px solid #15803d;color:#ffffff;cursor:pointer;font-size:12px;font-weight:800;padding:8px 14px;border-radius:8px;letter-spacing:0.01em;box-shadow:0 1px 2px rgba(22,163,74,0.2);">✓ Tamamla</button>';

            return '<div class="cv-task-card" style="padding:18px 20px;border:1px solid #e5e7eb;border-radius:12px;background:' + cardBg + ';margin-bottom:12px;' + (isDone ? 'opacity:0.75;' : '') + '">' +
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">' +
                    '<div style="flex:1;min-width:0;">' +
                        '<div style="' + titleStyle + '">' + escapeHtml(t.title || '') + '</div>' +
                        (t.description ? '<div style="font-size:13px;color:' + (isDone ? '#94a3b8' : '#334155') + ';line-height:1.55;margin-bottom:8px;">' + escapeHtml(t.description) + '</div>' : '') +
                        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
                            '<span style="font-size:12px;color:#64748b;font-weight:600;">📅 ' + escapeHtml(t.date || '') + '</span>' +
                            '<span style="font-size:13px;color:#f59e0b;">' + stars + '</span>' +
                            catBadge +
                            finBadge +
                        '</div>' +
                    '</div>' +
                    '<div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">' +
                        actionBtn +
                        '<button data-cv-del="' + escapeHtml(t.id) + '" style="background:transparent;border:none;color:#dc2626;cursor:pointer;font-size:18px;padding:2px 8px;">×</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
        }

        function sectionTitle(label, count, color) {
            return '<div style="display:flex;align-items:center;gap:8px;margin:8px 0 10px 0;">' +
                '<div style="font-size:12px;font-weight:700;color:' + color + ';text-transform:uppercase;letter-spacing:0.06em;">' + label + '</div>' +
                '<div style="font-size:11px;color:#94a3b8;font-weight:700;background:#f1f5f9;padding:2px 8px;border-radius:999px;">' + count + '</div>' +
            '</div>';
        }

        var activeHtml = '';
        if (active.length) {
            activeHtml += sectionTitle('Seçili Gün Görevleri', active.length, '#0f172a');
            activeHtml += active.map(renderCard).join('');
        }

        var doneHtml = '';
        if (done.length) {
            doneHtml += sectionTitle('Tamamlanan', done.length, '#16a34a');
            doneHtml += done.map(renderCard).join('');
        }

        listEl.innerHTML = headerHtml + activeHtml + doneHtml;

        // delete handlers
        listEl.querySelectorAll('[data-cv-del]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-cv-del');
                var list = loadTasks().filter(function (x) { return x.id !== id; });
                saveTasks(list);
                refreshAll(container);
            });
        });

        // done handlers
        listEl.querySelectorAll('[data-cv-done]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-cv-done');
                var list = loadTasks().map(function (x) {
                    if (x.id === id) {
                        x.is_done = true;
                        x.done_at = new Date().toISOString();
                    }
                    return x;
                });
                saveTasks(list);
                refreshAll(container);
            });
        });

        // undo handlers
        listEl.querySelectorAll('[data-cv-undo]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-cv-undo');
                var list = loadTasks().map(function (x) {
                    if (x.id === id) {
                        x.is_done = false;
                        delete x.done_at;
                    }
                    return x;
                });
                saveTasks(list);
                refreshAll(container);
            });
        });
    }

    // Tek noktadan tüm component'leri tazele — selectedDate korunur
    function refreshAll(container) {
        renderOverdueAlert(container);
        renderCalendar(container);
        renderTaskList(container);
        renderUpcomingPanel(container);
        renderCompletedPanel(container);
    }

    function renderOverdueAlert(container) {
        var bar = container.querySelector('#cvOverdueAlert');
        if (!bar) return;

        var now = new Date();
        var todayK = dateKey(now.getFullYear(), now.getMonth(), now.getDate());

        var overdueCount = loadTasks().filter(function (t) {
            return t && !t.is_done && t.date && t.date < todayK;
        }).length;

        if (!overdueCount) {
            bar.style.display = 'none';
            bar.innerHTML = '';
            return;
        }

        bar.style.display = 'block';
        bar.innerHTML =
            '<div style="display:flex;align-items:center;gap:14px;padding:14px 18px;border:1px solid #ef4444;background:#fee2e2;border-left:4px solid #ef4444;border-radius:12px;box-shadow:0 1px 2px rgba(239,68,68,0.06);">' +
                '<div style="width:30px;height:30px;border-radius:50%;background:#ef4444;color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;flex-shrink:0;">!</div>' +
                '<div style="flex:1;min-width:0;">' +
                    '<div style="font-size:14px;font-weight:800;color:#7f1d1d;line-height:1.3;">' + overdueCount + ' geciken görev var</div>' +
                    '<div style="font-size:12px;color:#991b1b;margin-top:2px;font-weight:600;">Lütfen kontrol et ve güncelle.</div>' +
                '</div>' +
            '</div>';
    }

    function renderUpcomingPanel(container) {
        var panel = container.querySelector('#cvUpcomingPanel');
        if (!panel) return;

        var now = new Date();
        var todayK = dateKey(now.getFullYear(), now.getMonth(), now.getDate());

        var activeAll = loadTasks().filter(function (t) { return t && !t.is_done && t.date; });
        var overdueList = activeAll
            .filter(function (t) { return t.date < todayK; })
            .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
        var futureList = activeAll
            .filter(function (t) { return t.date >= todayK; })
            .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
        // geciken her zaman üstte
        var upcoming = overdueList.concat(futureList).slice(0, 7);

        var headerHtml =
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
                '<div style="font-size:13px;font-weight:800;color:#334155;text-transform:uppercase;letter-spacing:0.06em;">Yaklaşan</div>' +
                '<div style="font-size:11px;color:#64748b;font-weight:700;background:#e2e8f0;padding:2px 8px;border-radius:999px;">' + upcoming.length + '</div>' +
            '</div>';

        if (!upcoming.length) {
            panel.innerHTML = headerHtml +
                '<div style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;border:1px dashed #e2e8f0;border-radius:10px;background:#fff;">' +
                    'Yaklaşan görev yok' +
                '</div>';
            return;
        }

        function priorityTone(p) {
            var n = Number(p) || 1;
            if (n >= 3) return { bg: '#ffffff', border: '#e2e8f0', accent: '#dc2626', star: '#dc2626' };
            if (n === 2) return { bg: '#ffffff', border: '#e2e8f0', accent: '#f59e0b', star: '#f59e0b' };
            return        { bg: '#ffffff', border: '#e2e8f0', accent: '#3b82f6', star: '#3b82f6' };
        }
        // Geciken tonu (priority'yi ezer)
        var OVERDUE_TONE = { bg: '#fef2f2', border: '#fecaca', accent: '#dc2626', star: '#dc2626' };

        function formatRelative(dateStr) {
            var parts = dateStr.split('-');
            var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
            var t = new Date();
            var dayMs = 86400000;
            var diff = Math.round((d.setHours(0,0,0,0) - t.setHours(0,0,0,0)) / dayMs);
            if (diff === 0) return 'Bugün';
            if (diff === 1) return 'Yarın';
            if (diff > 1)   return diff + ' gün kaldı';
            if (diff === -1) return 'Dün';
            return Math.abs(diff) + ' gün önce';
        }

        var cardsHtml = upcoming.map(function (t) {
            var isOverdue = t.date < todayK;
            var tone = isOverdue ? OVERDUE_TONE : priorityTone(t.priority);
            var stars = '★'.repeat(Math.max(1, Math.min(3, Number(t.priority) || 1)));
            var cat = escapeHtml(t.category || '');
            var catBadge = cat
                ? '<span style="display:inline-flex;align-items:center;padding:2px 6px;border-radius:5px;background:#e0e7ff;color:#3730a3;font-size:10px;font-weight:700;">' + cat + '</span>'
                : '';

            var pretty = formatRelative(t.date);

            var overdueBadge = isOverdue
                ? '<span style="display:inline-flex;align-items:center;padding:2px 6px;border-radius:5px;background:#dc2626;color:#fff;font-size:9px;font-weight:800;letter-spacing:0.06em;margin-right:4px;">GECİKTİ</span>'
                : '';

            var dateHtml = isOverdue
                ? '<span style="font-size:11px;color:#b91c1c;font-weight:800;">' + pretty + '</span>' +
                  '<span style="font-size:11px;color:#dc2626;font-weight:700;">⚠ Gecikti</span>'
                : '<span style="font-size:11px;color:' + tone.accent + ';font-weight:700;">' + pretty + '</span>';

            var cardBorder = isOverdue
                ? 'border:1px solid #e5e7eb;border-left:3px solid #dc2626;'
                : 'border:1px solid ' + tone.border + ';border-left:3px solid ' + tone.accent + ';';
            var cardBg = '#ffffff';
            var cardShadow = '0 1px 2px rgba(15,23,42,0.04)';

            return '<div data-cv-upcoming="' + escapeHtml(t.id) + '" data-cv-upcoming-date="' + escapeHtml(t.date) + '" ' +
                'style="padding:10px 12px 10px 14px;' + cardBorder + 'border-radius:10px;background:' + cardBg + ';margin-bottom:8px;cursor:pointer;transition:transform 0.12s ease, box-shadow 0.12s ease;box-shadow:' + cardShadow + ';">' +
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">' +
                    '<div style="font-size:13px;font-weight:800;color:#020617;line-height:1.35;flex:1;min-width:0;letter-spacing:-0.005em;">' +
                        overdueBadge + escapeHtml(t.title || '') +
                    '</div>' +
                    '<span style="font-size:11px;color:' + tone.star + ';font-weight:700;flex-shrink:0;">' + stars + '</span>' +
                '</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
                    dateHtml +
                    catBadge +
                '</div>' +
            '</div>';
        }).join('');

        panel.innerHTML = headerHtml + cardsHtml;

        panel.querySelectorAll('[data-cv-upcoming]').forEach(function (card) {
            card.addEventListener('click', function () {
                var d = card.getAttribute('data-cv-upcoming-date');
                if (!d) return;
                var parts = d.split('-');
                var y = Number(parts[0]);
                var m = Number(parts[1]) - 1;
                _viewState.selectedDate = d;
                _viewState.year = y;
                _viewState.month = m;
                refreshAll(container);
            });
            card.addEventListener('mouseenter', function () {
                card.style.transform = 'translateY(-1px)';
                card.style.boxShadow = '0 4px 10px rgba(15,23,42,0.06)';
            });
            card.addEventListener('mouseleave', function () {
                card.style.transform = '';
                card.style.boxShadow = '';
            });
        });
    }

    function renderCompletedPanel(container) {
        var panel = container.querySelector('#cvCompletedPanel');
        if (!panel) return;

        var all = loadTasks().filter(function (t) { return !!t.is_done; });
        // en son tamamlanan üstte
        all.sort(function (a, b) {
            var av = a.done_at || a.created_at || '';
            var bv = b.done_at || b.created_at || '';
            return String(bv).localeCompare(String(av));
        });

        var MAX = 5;
        var totalDone = all.length;
        var shown = all.slice(0, MAX);

        var headerHtml =
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
                '<div style="font-size:13px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:0.06em;">Tamamlanan</div>' +
                '<div style="font-size:11px;color:#64748b;font-weight:700;background:#e2e8f0;padding:2px 8px;border-radius:999px;">' + totalDone + '</div>' +
            '</div>';

        if (!totalDone) {
            panel.innerHTML = headerHtml +
                '<div style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;border:1px dashed #e2e8f0;border-radius:10px;background:#fff;">' +
                    'Henüz tamamlanan görev yok.' +
                '</div>';
            return;
        }

        var cardsHtml = shown.map(function (t) {
            var cat = escapeHtml(t.category || '');
            var catBadge = cat
                ? '<span style="display:inline-flex;align-items:center;padding:2px 6px;border-radius:5px;background:#e2e8f0;color:#475569;font-size:10px;font-weight:700;">' + cat + '</span>'
                : '';
            return '<div style="padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;background:#fff;margin-bottom:8px;">' +
                '<div style="font-size:13px;font-weight:700;color:#64748b;text-decoration:line-through;margin-bottom:6px;line-height:1.35;">' +
                    escapeHtml(t.title || '') +
                '</div>' +
                '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">' +
                    '<span style="font-size:11px;color:#94a3b8;font-weight:600;">📅 ' + escapeHtml(t.date || '') + '</span>' +
                    catBadge +
                '</div>' +
                '<button data-cv-undo-panel="' + escapeHtml(t.id) + '" style="width:100%;background:#f1f5f9;border:1px solid #e2e8f0;color:#334155;font-size:11px;font-weight:700;padding:5px 8px;border-radius:6px;cursor:pointer;">↺ Geri Al</button>' +
            '</div>';
        }).join('');

        var footerHtml = totalDone > MAX
            ? '<div style="font-size:11px;color:#94a3b8;text-align:center;margin-top:4px;">+ ' + (totalDone - MAX) + ' daha</div>'
            : '';

        panel.innerHTML = headerHtml + cardsHtml + footerHtml;

        panel.querySelectorAll('[data-cv-undo-panel]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-cv-undo-panel');
                var list = loadTasks().map(function (x) {
                    if (x.id === id) {
                        x.is_done = false;
                        delete x.done_at;
                    }
                    return x;
                });
                saveTasks(list);
                refreshAll(container);
            });
        });
    }

    // Gün bazında görevleri grupla: { 'YYYY-MM-DD': [task, ...] }
    function groupTasksByDate(tasks) {
        var map = {};
        for (var i = 0; i < tasks.length; i++) {
            var t = tasks[i];
            if (!t || !t.date) continue;
            if (!map[t.date]) map[t.date] = [];
            map[t.date].push(t);
        }
        return map;
    }

    function dotColorForPriority(p) {
        var n = Number(p) || 1;
        if (n >= 3) return '#dc2626'; // kırmızı
        if (n === 2) return '#f59e0b'; // turuncu
        return '#3b82f6'; // mavi
    }

    function dateKey(y, m, d) {
        var mm = String(m + 1).padStart(2, '0');
        var dd = String(d).padStart(2, '0');
        return y + '-' + mm + '-' + dd;
    }

    function shiftMonth(container, delta) {
        var y = _viewState.year;
        var m = _viewState.month + delta;
        if (m < 0) { m = 11; y--; }
        else if (m > 11) { m = 0; y++; }
        _viewState.year = y;
        _viewState.month = m;
        renderCalendar(container);
    }

    function renderCalendar(container) {
        var wrap = container.querySelector('#cvCalendar');
        if (!wrap) return;

        var year = _viewState.year;
        var month = _viewState.month;

        // ayın ilk günü ve gün sayısı
        var firstDay = new Date(year, month, 1);
        var daysInMonth = new Date(year, month + 1, 0).getDate();
        // haftanın başı Pazartesi: JS getDay → Paz=0, Pzt=1...; normalize: Pzt=0, Paz=6
        var firstWeekday = (firstDay.getDay() + 6) % 7;
        // önceki aydan sızıntı
        var prevMonthDays = new Date(year, month, 0).getDate();

        // Sadece AKTİF görevler dot olarak gösterilsin
        var tasks = loadTasks().filter(function (t) { return t && !t.is_done; });
        var byDate = groupTasksByDate(tasks);

        var today = new Date();
        var todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());

        var headerHtml =
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
                '<button id="cvPrevMonth" type="button" style="background:#f1f5f9;border:none;width:34px;height:34px;border-radius:8px;font-size:16px;cursor:pointer;color:#334155;">‹</button>' +
                '<div style="font-size:18px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">' +
                    MONTH_NAMES[month] + ' ' + year +
                '</div>' +
                '<button id="cvNextMonth" type="button" style="background:#f1f5f9;border:none;width:34px;height:34px;border-radius:8px;font-size:16px;cursor:pointer;color:#334155;">›</button>' +
            '</div>';

        // hafta günü başlığı
        var weekHtml = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:6px;">';
        for (var w = 0; w < 7; w++) {
            var isWeekend = w >= 5;
            weekHtml += '<div style="text-align:center;font-size:11px;font-weight:700;color:' + (isWeekend ? '#dc2626' : '#64748b') + ';text-transform:uppercase;letter-spacing:0.06em;padding:6px 0;">' +
                WEEK_DAYS[w] + '</div>';
        }
        weekHtml += '</div>';

        // Grid
        var cellsHtml = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;">';

        // prev month leading cells
        for (var i = firstWeekday - 1; i >= 0; i--) {
            var dPrev = prevMonthDays - i;
            cellsHtml += '<div style="min-height:78px;border:1px solid #eef2f7;border-radius:12px;padding:10px;background:#fafbfd;color:#cbd5e1;font-size:12px;font-weight:600;">' +
                dPrev +
            '</div>';
        }

        // current month
        for (var d = 1; d <= daysInMonth; d++) {
            var key = dateKey(year, month, d);
            var dayTasks = byDate[key] || [];
            var isToday = key === todayKey;

            // sort by priority desc
            var sortedTasks = dayTasks.slice().sort(function (a, b) {
                return (Number(b.priority) || 0) - (Number(a.priority) || 0);
            });

            var dotsHtml = '';
            var maxDots = 3;
            var shown = Math.min(sortedTasks.length, maxDots);
            for (var di = 0; di < shown; di++) {
                dotsHtml += '<span style="width:6px;height:6px;border-radius:50%;background:' + dotColorForPriority(sortedTasks[di].priority) + ';display:inline-block;"></span>';
            }
            if (sortedTasks.length > maxDots) {
                dotsHtml += '<span style="font-size:10px;font-weight:700;color:#64748b;margin-left:2px;">+' + (sortedTasks.length - maxDots) + '</span>';
            }

            var titleAttr = sortedTasks.length
                ? escapeHtml(sortedTasks.length + ' görev')
                : '';

            var isSelected = key === _viewState.selectedDate;

            var borderColor = isSelected ? '#4f46e5' : (isToday ? '#6366f1' : '#e5e7eb');
            var borderWidth = isSelected ? '2px' : '1px';
            var bgColor = isSelected ? '#eef2ff' : '#ffffff';

            var cellStyle = 'min-height:78px;border:' + borderWidth + ' solid ' + borderColor + ';border-radius:12px;padding:10px;background:' + bgColor + ';display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;';

            cellsHtml += '<div data-cv-day="' + key + '" class="cv-day-cell' + (isSelected ? ' cv-selected' : '') + '" title="' + titleAttr + '" style="' + cellStyle + '">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                    '<span style="font-size:13px;font-weight:' + (isToday || isSelected ? '800' : '600') + ';color:' + (isSelected ? '#3730a3' : (isToday ? '#4338ca' : '#0f172a')) + ';">' + d + '</span>' +
                '</div>' +
                (dotsHtml ? '<div style="display:flex;align-items:center;gap:4px;margin-top:6px;">' + dotsHtml + '</div>' : '') +
            '</div>';
        }

        // trailing next-month cells → 7'ye tamamla
        var totalCells = firstWeekday + daysInMonth;
        var trailing = (7 - (totalCells % 7)) % 7;
        for (var t2 = 1; t2 <= trailing; t2++) {
            cellsHtml += '<div style="min-height:78px;border:1px solid #eef2f7;border-radius:12px;padding:10px;background:#fafbfd;color:#cbd5e1;font-size:12px;font-weight:600;">' +
                t2 +
            '</div>';
        }

        cellsHtml += '</div>';

        wrap.innerHTML = headerHtml + weekHtml + cellsHtml;

        // Nav listeners
        var prevBtn = wrap.querySelector('#cvPrevMonth');
        var nextBtn = wrap.querySelector('#cvNextMonth');
        if (prevBtn) prevBtn.addEventListener('click', function () { shiftMonth(container, -1); });
        if (nextBtn) nextBtn.addEventListener('click', function () { shiftMonth(container, 1); });

        // Day click → selectedDate update + re-render
        wrap.querySelectorAll('[data-cv-day]').forEach(function (cell) {
            cell.addEventListener('click', function () {
                var key = cell.getAttribute('data-cv-day');
                if (!key) return;
                _viewState.selectedDate = (_viewState.selectedDate === key) ? null : key;
                renderCalendar(container);
                renderTaskList(container);
                // selectedDate korundu, sadece sol sütun tazelendi

            });
        });
    }

    function renderCategoryDropdown(container, filterText) {
        var dd = container.querySelector('#cvCategoryDropdown');
        if (!dd) return;

        var all = getUniqueCategories(loadTasks());
        var q = (filterText || '').trim().toLocaleLowerCase('tr-TR');
        var list = q
            ? all.filter(function (c) { return c.toLocaleLowerCase('tr-TR').indexOf(q) !== -1; })
            : all.slice();

        if (!list.length) {
            dd.innerHTML = '<div style="padding:10px 12px;font-size:13px;color:#94a3b8;">' +
                (q ? '"' + escapeHtml(filterText) + '" yeni kategori olarak eklenecek' : 'Henüz kategori yok — yazarak yeni ekleyebilirsin') +
                '</div>';
            return;
        }

        dd.innerHTML = list.map(function (c) {
            return '<div data-cv-cat="' + escapeHtml(c) + '" style="padding:9px 12px;font-size:14px;color:#0f172a;cursor:pointer;border-bottom:1px solid #f1f5f9;">' +
                escapeHtml(c) +
            '</div>';
        }).join('');

        dd.querySelectorAll('[data-cv-cat]').forEach(function (row) {
            row.addEventListener('mousedown', function (e) {
                e.preventDefault(); // input blur olmasın
                var val = row.getAttribute('data-cv-cat');
                var input = container.querySelector('#cvTaskCategory');
                if (input) input.value = val;
                closeCategoryDropdown(container);
            });
            row.addEventListener('mouseenter', function () { row.style.background = '#f8fafc'; });
            row.addEventListener('mouseleave', function () { row.style.background = '#fff'; });
        });
    }

    function openCategoryDropdown(container) {
        var dd = container.querySelector('#cvCategoryDropdown');
        if (!dd) return;
        var input = container.querySelector('#cvTaskCategory');
        renderCategoryDropdown(container, input ? input.value : '');
        dd.style.display = 'block';
    }

    function closeCategoryDropdown(container) {
        var dd = container.querySelector('#cvCategoryDropdown');
        if (dd) dd.style.display = 'none';
    }

    function openModal(container) {
        var overlay = container.querySelector('#cvModalOverlay');
        if (!overlay) return;

        // default date = today
        var dateInput = container.querySelector('#cvTaskDate');
        if (dateInput && !dateInput.value) dateInput.value = todayISO();

        overlay.style.display = 'flex';
        closeCategoryDropdown(container);
    }

    function closeModal(container) {
        var overlay = container.querySelector('#cvModalOverlay');
        if (!overlay) return;
        overlay.style.display = 'none';

        // reset
        container.querySelector('#cvTaskTitle').value = '';
        container.querySelector('#cvTaskDesc').value = '';
        container.querySelector('#cvTaskDate').value = '';
        container.querySelector('#cvTaskCategory').value = '';
        container.querySelector('#cvTaskPriority').value = '2';
        container.querySelector('#cvTaskFinancial').checked = false;
        container.querySelector('#cvFormError').textContent = '';
    }

    function handleSubmit(container) {
        var title = (container.querySelector('#cvTaskTitle').value || '').trim();
        var desc  = (container.querySelector('#cvTaskDesc').value || '').trim();
        var date  = container.querySelector('#cvTaskDate').value;
        var cat   = normalizeCategory(container.querySelector('#cvTaskCategory').value);
        var prio  = Number(container.querySelector('#cvTaskPriority').value || 2);
        var fin   = !!container.querySelector('#cvTaskFinancial').checked;
        var errEl = container.querySelector('#cvFormError');

        if (!title) { errEl.textContent = 'Başlık zorunlu.'; return; }
        if (!date)  { errEl.textContent = 'Tarih zorunlu.';  return; }

        var list = loadTasks();
        list.push({
            id: 'cv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            title: title,
            description: desc,
            date: date,
            category: cat,
            priority: prio,
            is_financial: fin,
            is_done: false,
            created_at: new Date().toISOString()
        });
        saveTasks(list);

        closeModal(container);
        refreshAll(container);
    }

    function bindEvents(container) {
        container.querySelector('#cvAddBtn').addEventListener('click', function () {
            openModal(container);
        });
        container.querySelector('#cvModalClose').addEventListener('click', function () {
            closeModal(container);
        });
        container.querySelector('#cvModalCancel').addEventListener('click', function () {
            closeModal(container);
        });
        // Overlay click: modal kapanmayacak, sadece açık dropdown'u kapat.
        container.querySelector('#cvModalOverlay').addEventListener('click', function (e) {
            var dd = container.querySelector('#cvCategoryDropdown');
            var catInput = container.querySelector('#cvTaskCategory');

            var clickedInsideDropdown = dd && dd.contains(e.target);
            var clickedOnCatInput = catInput && catInput.contains(e.target);

            // Dropdown açık ve tıklama dropdown/input dışında → sadece dropdown kapansın
            if (dd && dd.style.display === 'block' && !clickedInsideDropdown && !clickedOnCatInput) {
                e.stopPropagation();
                closeCategoryDropdown(container);
            }
            // Modal kapanmayacak — overlay backdrop tıklaması yok sayılır.
        });
        container.querySelector('#cvTaskForm').addEventListener('submit', function (e) {
            e.preventDefault();
            handleSubmit(container);
        });

        // Kategori dropdown davranışı
        var catInput = container.querySelector('#cvTaskCategory');
        if (catInput) {
            catInput.addEventListener('focus', function () {
                openCategoryDropdown(container);
            });
            catInput.addEventListener('click', function () {
                openCategoryDropdown(container);
            });
            catInput.addEventListener('input', function () {
                renderCategoryDropdown(container, catInput.value);
                var dd = container.querySelector('#cvCategoryDropdown');
                if (dd) dd.style.display = 'block';
            });
            catInput.addEventListener('blur', function () {
                // mousedown ile seçim yapılıyor (blur öncesi), burada güvenle kapat
                setTimeout(function () { closeCategoryDropdown(container); }, 0);
            });
            catInput.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' || e.key === 'Esc') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeCategoryDropdown(container);
                }
            });
        }

        // Global ESC — dropdown açıksa kapat (modal açık kalsın)
        // capture phase → başka listener yutmadan önce yakala
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape' && e.key !== 'Esc') return;
            var dd = container.querySelector('#cvCategoryDropdown');
            if (dd && dd.style.display === 'block') {
                e.preventDefault();
                e.stopPropagation();
                if (typeof e.stopImmediatePropagation === 'function') {
                    e.stopImmediatePropagation();
                }
                closeCategoryDropdown(container);
            }
        }, true);
    }

    function _injectLayoutStyle() {
        if (document.getElementById('cv-layout-style')) return;
        var s = document.createElement('style');
        s.id = 'cv-layout-style';
        s.textContent =
            '.cv-layout-grid{display:grid;grid-template-columns:1fr 2fr 1fr;gap:24px;align-items:start;}' +
            '.cv-side-panel{position:sticky;top:20px;}' +
            '.cv-day-cell{transition:transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease, background 0.15s ease;}' +
            '.cv-day-cell:hover{transform:translateY(-2px);box-shadow:0 6px 14px rgba(15,23,42,0.07);border-color:#c7d2fe;}' +
            '.cv-day-cell.cv-selected{box-shadow:0 0 0 2px rgba(79,70,229,0.35), 0 8px 20px rgba(79,70,229,0.18);transform:translateY(-2px);}' +
            '.cv-task-card{transition:transform 0.15s ease, box-shadow 0.15s ease;box-shadow:0 1px 2px rgba(15,23,42,0.04);}' +
            '.cv-task-card:hover{box-shadow:0 8px 22px rgba(15,23,42,0.08);transform:translateY(-2px);}' +
            '@media (max-width: 1100px){' +
                '.cv-layout-grid{grid-template-columns:1fr;gap:18px;}' +
                '.cv-side-panel{position:static;}' +
            '}';
        document.head.appendChild(s);
    }

    function render(container) {
        _injectLayoutStyle();
        // init grid state to current month + select today by default
        var _now = new Date();
        _viewState.year = _now.getFullYear();
        _viewState.month = _now.getMonth();
        _viewState.selectedDate = dateKey(_now.getFullYear(), _now.getMonth(), _now.getDate());

        container.innerHTML =
            '<div style="max-width:1400px;margin:0 auto;padding:24px 20px;background:#f7f8fa;min-height:100vh;">' +
                '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;gap:12px;flex-wrap:wrap;">' +
                    '<div>' +
                        '<h2 style="margin:0 0 4px 0;font-size:24px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;">Takvim & Görevler</h2>' +
                        '<p style="margin:0;font-size:14px;color:#64748b;">Görevlerini ekle ve takip et.</p>' +
                    '</div>' +
                    '<button id="cvAddBtn" type="button" style="background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;border:none;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(79,70,229,0.25);">+ Görev Ekle</button>' +
                '</div>' +

                '<div class="cv-layout-grid">' +
                    '<aside id="cvUpcomingPanel" class="cv-side-panel" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;box-shadow:0 1px 2px rgba(15,23,42,0.04);"></aside>' +
                    '<div class="cv-center-col" style="min-width:0;">' +
                        '<div id="cvOverdueAlert" style="display:none;margin-bottom:20px;"></div>' +
                        '<div id="cvCalendar" style="margin-bottom:32px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;box-shadow:0 1px 2px rgba(15,23,42,0.04);"></div>' +
                        '<div id="cvTaskList"></div>' +
                    '</div>' +
                    '<aside id="cvCompletedPanel" class="cv-side-panel" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;box-shadow:0 1px 2px rgba(15,23,42,0.04);"></aside>' +
                '</div>' +

                // MODAL
                '<div id="cvModalOverlay" style="display:none;position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:9999;align-items:center;justify-content:center;padding:20px;">' +
                    '<div style="background:#fff;border-radius:16px;max-width:480px;width:100%;padding:24px;box-shadow:0 20px 60px rgba(15,23,42,0.25);">' +
                        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">' +
                            '<h3 style="margin:0;font-size:18px;font-weight:800;color:#0f172a;">Yeni Görev</h3>' +
                            '<button id="cvModalClose" type="button" style="background:transparent;border:none;font-size:22px;color:#64748b;cursor:pointer;line-height:1;">×</button>' +
                        '</div>' +

                        '<form id="cvTaskForm">' +
                            // Başlık
                            '<label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em;">Başlık *</label>' +
                            '<input id="cvTaskTitle" type="text" maxlength="120" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;margin-bottom:14px;" />' +

                            // Açıklama
                            '<label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em;">Açıklama</label>' +
                            '<textarea id="cvTaskDesc" rows="3" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;margin-bottom:14px;resize:vertical;font-family:inherit;"></textarea>' +

                            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                                // Tarih
                                '<div>' +
                                    '<label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em;">Tarih *</label>' +
                                    '<input id="cvTaskDate" type="date" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;margin-bottom:14px;" />' +
                                '</div>' +
                                // Öncelik
                                '<div>' +
                                    '<label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em;">Öncelik</label>' +
                                    '<select id="cvTaskPriority" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;margin-bottom:14px;background:#fff;">' +
                                        '<option value="1">★ Düşük</option>' +
                                        '<option value="2" selected>★★ Orta</option>' +
                                        '<option value="3">★★★ Yüksek</option>' +
                                    '</select>' +
                                '</div>' +
                            '</div>' +

                            // Kategori (custom dropdown)
                            '<label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.04em;">Kategori</label>' +
                            '<div style="position:relative;margin-bottom:14px;">' +
                                '<input id="cvTaskCategory" type="text" autocomplete="off" placeholder="Banka, Fatura, Toplantı..." style="width:100%;box-sizing:border-box;padding:10px 38px 10px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;" />' +
                                '<span id="cvCategoryCaret" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);color:#94a3b8;pointer-events:none;font-size:12px;">▼</span>' +
                                '<div id="cvCategoryDropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 10px 24px rgba(15,23,42,0.1);max-height:220px;overflow-y:auto;z-index:10;"></div>' +
                            '</div>' +

                            // Finansal mı
                            '<label style="display:flex;align-items:center;gap:8px;font-size:14px;color:#334155;margin-bottom:18px;cursor:pointer;user-select:none;">' +
                                '<input id="cvTaskFinancial" type="checkbox" style="width:16px;height:16px;cursor:pointer;" />' +
                                '<span>Finansal görev mi? <span style="color:#64748b;font-size:12px;">(ödeme, fatura vb.)</span></span>' +
                            '</label>' +

                            '<div id="cvFormError" style="color:#dc2626;font-size:13px;font-weight:600;margin-bottom:12px;min-height:18px;"></div>' +

                            '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
                                '<button id="cvModalCancel" type="button" style="background:#f1f5f9;color:#334155;border:none;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer;">Vazgeç</button>' +
                                '<button type="submit" style="background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;border:none;border-radius:10px;padding:10px 18px;font-size:14px;font-weight:700;cursor:pointer;">Kaydet</button>' +
                            '</div>' +
                        '</form>' +
                    '</div>' +
                '</div>' +
            '</div>';

        bindEvents(container);
        refreshAll(container);
    }

    return { render: render };
})();
