/* ============================================================
   SETTINGS VIEW — Tabbed admin/settings panel
   Tabs: Genel | Veri | Aktarma | Güvenlik | Sistem
   "Veri Aktarma" reuses window.TransferView 1:1.
   ============================================================ */

window.SettingsView = {
    activeTab: 'genel',
    _transferMounted: false,

    render(container) {
        var self = this;
        this.container = container;

        var tabs = [
            { key: 'genel',     label: 'Genel'     },
            { key: 'veri',      label: 'Veri'      },
            { key: 'aktarma',   label: 'Aktarma'   },
            { key: 'sistem',    label: 'Sistem'    }
        ];

        var tabBar = tabs.map(function (t) {
            var active = (t.key === self.activeTab);
            return '<button type="button" data-tab="' + t.key + '" ' +
                'class="settings-tab-btn' + (active ? ' active' : '') + '" ' +
                'style="' +
                    'padding:9px 18px;border:none;border-radius:9px;' +
                    'background:' + (active ? '#ffffff' : 'transparent') + ';' +
                    'color:' + (active ? '#0f172a' : '#64748b') + ';' +
                    'font-size:13.5px;font-weight:' + (active ? '700' : '600') + ';' +
                    'letter-spacing:-0.01em;cursor:pointer;transition:all .18s ease;' +
                    'box-shadow:' + (active ? '0 1px 3px rgba(15,23,42,0.08), 0 1px 2px rgba(15,23,42,0.04)' : 'none') + ';' +
                    'white-space:nowrap;' +
                '">' +
                t.label +
                '</button>';
        }).join('');

        var tenantName = (window.STATE && window.STATE.tenant && window.STATE.tenant.name) ||
                         (window.STATE && window.STATE.profile && window.STATE.profile.business_name) ||
                         '—';

        container.innerHTML =
            '<style>' +
                '.settings-tab-btn:hover:not(.active){background:rgba(15,23,42,0.04);color:#0f172a;}' +
                '@media (max-width: 720px){' +
                    '.settings-header-card{padding:18px 18px !important;}' +
                    '.settings-header-row{flex-direction:column !important;align-items:flex-start !important;gap:14px !important;}' +
                    '.settings-header-meta{width:100%;justify-content:flex-start !important;}' +
                    '.settings-header-title{font-size:24px !important;}' +
                '}' +
            '</style>' +

            '<div style="max-width:1100px;margin:0 auto;padding:14px 20px 32px;">' +

                '<div class="settings-header-card" style="' +
                    'background:linear-gradient(180deg,#ffffff 0%,#fafbfc 100%);' +
                    'border:1px solid #e5e7eb;border-radius:18px;' +
                    'padding:22px 26px 14px;' +
                    'box-shadow:0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.08);' +
                '">' +

                    '<div class="settings-header-row" style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px;">' +
                        '<div style="min-width:0;">' +
                            '<h1 class="settings-header-title" style="margin:0;font-size:28px;font-weight:800;color:#0f172a;letter-spacing:-0.025em;line-height:1.1;">Ayarlar</h1>' +
                            '<p style="margin:6px 0 0;color:#64748b;font-size:14px;line-height:1.4;">İşletme tercihleri, veri yönetimi ve sistem ayarları</p>' +
                        '</div>' +
                        '<div class="settings-header-meta" style="display:flex;align-items:center;gap:18px;flex-shrink:0;">' +
                            '<div style="text-align:right;">' +
                                '<div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.06em;text-transform:uppercase;">Tenant</div>' +
                                '<div style="margin-top:3px;font-size:13px;font-weight:700;color:#0f172a;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + tenantName + '</div>' +
                            '</div>' +
                            '<div style="width:1px;height:32px;background:#e5e7eb;"></div>' +
                            '<div style="text-align:right;">' +
                                '<div style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.06em;text-transform:uppercase;">Son Yedek</div>' +
                                this._renderLastBackupHtml() +
                            '</div>' +
                            '<div style="display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;background:#ecfdf5;border:1px solid #a7f3d0;">' +
                                '<span style="width:7px;height:7px;border-radius:50%;background:#16a34a;box-shadow:0 0 0 3px rgba(22,163,74,0.18);"></span>' +
                                '<span style="font-size:12px;font-weight:700;color:#15803d;letter-spacing:-0.01em;">Aktif</span>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +

                    '<div style="margin-top:18px;padding:5px;background:#f1f5f9;border-radius:12px;display:inline-flex;gap:3px;max-width:100%;overflow-x:auto;">' +
                        tabBar +
                    '</div>' +

                '</div>' +

                '<div id="settingsPanelGenel"    style="display:' + (this.activeTab === 'genel'    ? 'block' : 'none') + ';margin-top:22px;">' + this.renderGenel()    + '</div>' +
                '<div id="settingsPanelVeri"     style="display:' + (this.activeTab === 'veri'     ? 'block' : 'none') + ';margin-top:22px;">' + this.renderVeri()     + '</div>' +
                '<div id="settingsPanelAktarma"  style="display:' + (this.activeTab === 'aktarma'  ? 'block' : 'none') + ';margin-top:22px;">' + this.renderAktarma()  + '</div>' +
                '<div id="settingsPanelSistem"   style="display:' + (this.activeTab === 'sistem'   ? 'block' : 'none') + ';margin-top:22px;">' + this.renderSistem()   + '</div>' +
            '</div>';

        this.bindTabEvents();
        this.bindBackupEvents();

        if (this.activeTab === 'aktarma') {
            this.mountTransfer();
        }
    },

    bindTabEvents() {
        var self = this;
        var btns = this.container.querySelectorAll('.settings-tab-btn');
        btns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                self.setActiveTab(btn.dataset.tab);
            });
        });
    },

    setActiveTab(key) {
        this.activeTab = key;

        var map = {
            genel:    'settingsPanelGenel',
            veri:     'settingsPanelVeri',
            aktarma:  'settingsPanelAktarma',
            sistem:   'settingsPanelSistem'
        };

        Object.keys(map).forEach(function (k) {
            var el = document.getElementById(map[k]);
            if (el) el.style.display = (k === key) ? 'block' : 'none';
        });

        var btns = this.container.querySelectorAll('.settings-tab-btn');
        btns.forEach(function (btn) {
            var active = (btn.dataset.tab === key);
            btn.classList.toggle('active', active);
            btn.style.background = active ? '#ffffff' : 'transparent';
            btn.style.color = active ? '#0f172a' : '#64748b';
            btn.style.fontWeight = active ? '700' : '600';
            btn.style.boxShadow = active
                ? '0 1px 3px rgba(15,23,42,0.08), 0 1px 2px rgba(15,23,42,0.04)'
                : 'none';
        });

        if (key === 'aktarma') {
            this.mountTransfer();
        }
    },

    /* ============================================================
       PANEL RENDERERS
    ============================================================ */

    sectionCard(title, subtitle, body) {
        return '' +
            '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px 24px;margin-bottom:18px;">' +
                '<div style="margin-bottom:16px;">' +
                    '<h3 style="margin:0;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">' + title + '</h3>' +
                    (subtitle ? '<p style="margin:4px 0 0;color:#64748b;font-size:13px;">' + subtitle + '</p>' : '') +
                '</div>' +
                body +
            '</div>';
    },

    inputField(label, placeholder, value, type) {
        type = type || 'text';
        return '' +
            '<div style="margin-bottom:16px;">' +
                '<label style="display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px;">' + label + '</label>' +
                '<input type="' + type + '" placeholder="' + (placeholder || '') + '" value="' + (value || '') + '" ' +
                'style="width:100%;max-width:420px;padding:11px 14px;border:1px solid #d1d5db;border-radius:10px;' +
                'font-size:14px;color:#0f172a;background:#fff;box-sizing:border-box;font-family:inherit;">' +
            '</div>';
    },

    renderGenel() {
        var bizName = (window.STATE && window.STATE.tenant && window.STATE.tenant.name) ||
                      (window.STATE && window.STATE.profile && window.STATE.profile.business_name) ||
                      '';

        var nameDisplay = bizName || '—';

        var body = '' +
            // === İŞLETME ADI (readonly + Düzenle) ===
            '<div style="margin-bottom:22px;">' +
                '<label style="display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px;">İşletme Adı</label>' +

                '<div id="bizNameViewMode" style="display:flex;align-items:center;gap:10px;max-width:480px;">' +
                    '<div id="bizNameDisplay" style="flex:1;padding:11px 14px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;color:#0f172a;font-size:14px;font-weight:600;min-height:20px;">' +
                        this.escapeHtml(nameDisplay) +
                    '</div>' +
                    '<button id="bizNameEditBtn" type="button" style="padding:11px 16px;border:1px solid #e5e7eb;background:#ffffff;color:#0f172a;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">Düzenle</button>' +
                '</div>' +

                '<div id="bizNameEditMode" style="display:none;align-items:center;gap:10px;max-width:480px;">' +
                    '<input id="bizNameInput" type="text" placeholder="Örn: Holly Stone Adana" value="' + this.escapeAttr(bizName) + '" ' +
                        'style="flex:1;padding:11px 14px;border:1px solid #0f172a;border-radius:10px;font-size:14px;color:#0f172a;background:#fff;box-sizing:border-box;font-family:inherit;outline:none;">' +
                    '<button id="bizNameSaveBtn"   type="button" style="padding:11px 16px;border:none;background:#0f172a;color:#fff;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">Kaydet</button>' +
                    '<button id="bizNameCancelBtn" type="button" style="padding:11px 16px;border:1px solid #e5e7eb;background:#ffffff;color:#475569;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;">İptal</button>' +
                '</div>' +
            '</div>' +

            // === PARA BİRİMİ (readonly) ===
            '<div style="max-width:420px;">' +
                '<label style="display:block;font-size:13px;font-weight:600;color:#475569;margin-bottom:6px;">Para Birimi</label>' +
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">' +
                    '<span style="font-size:14px;font-weight:600;color:#0f172a;">₺ — Türk Lirası</span>' +
                    '<span style="font-size:11px;font-weight:700;color:#94a3b8;letter-spacing:0.06em;text-transform:uppercase;">Sabit</span>' +
                '</div>' +
                '<p style="margin:8px 0 0;font-size:12px;color:#94a3b8;line-height:1.5;">Tüm sistem hesaplamaları Türk Lirası üzerinden yapılır. Bu ayar değiştirilemez.</p>' +
            '</div>';

        // === EVENT BINDING ===
        var self = this;
        setTimeout(function () { self._bindGenelEvents(); }, 0);

        return this.sectionCard('İşletme Bilgileri', 'Genel işletme tercihleri', body);
    },

    _bindGenelEvents() {
        var view   = document.getElementById('bizNameViewMode');
        var edit   = document.getElementById('bizNameEditMode');
        var editBtn   = document.getElementById('bizNameEditBtn');
        var saveBtn   = document.getElementById('bizNameSaveBtn');
        var cancelBtn = document.getElementById('bizNameCancelBtn');
        var input     = document.getElementById('bizNameInput');
        var display   = document.getElementById('bizNameDisplay');

        if (editBtn) {
            editBtn.onclick = function () {
                if (!view || !edit) return;
                view.style.display = 'none';
                edit.style.display = 'flex';
                if (input) { input.focus(); input.select(); }
            };
        }

        if (cancelBtn) {
            cancelBtn.onclick = function () {
                if (!view || !edit) return;
                edit.style.display = 'none';
                view.style.display = 'flex';
            };
        }

        if (saveBtn) {
            saveBtn.onclick = async function () {
                if (!input || !display || !view || !edit) return;
                var val = String(input.value || '').trim();
                if (!val) {
                    if (window.Toast && Toast.error) Toast.error('İşletme adı boş olamaz');
                    return;
                }

                var tenantId = (window.STATE && window.STATE.tenant && window.STATE.tenant.id) || null;
                if (!tenantId) {
                    if (window.Toast && Toast.error) Toast.error('Tenant bulunamadı');
                    return;
                }

                if (!window.SupabaseService || typeof window.SupabaseService.getClient !== 'function') {
                    if (window.Toast && Toast.error) Toast.error('Supabase servisi yüklenemedi');
                    return;
                }

                saveBtn.disabled = true;
                saveBtn.textContent = 'Kaydediliyor...';

                try {
                    var client = window.SupabaseService.getClient();
                    var res = await client
                        .from('tenants')
                        .update({ name: val })
                        .eq('id', tenantId)
                        .select('id,name')
                        .single();

                    if (res.error) {
                        if (window.Toast && Toast.error) Toast.error(res.error.message || 'Kaydetme başarısız');
                        return;
                    }

                    // 1) STATE
                    if (window.STATE && window.STATE.tenant) {
                        window.STATE.tenant.name = val;
                    }

                    // 2) Header / sub-header
                    var businessNameEl = document.getElementById('businessName');
                    if (businessNameEl) businessNameEl.textContent = val;

                    // 3) Settings header tenant text
                    var headerMeta = document.querySelector('.settings-header-meta');
                    if (headerMeta) {
                        var tenantText = headerMeta.querySelector('div[style*="font-weight:700"][style*="overflow:hidden"]');
                        if (tenantText) tenantText.textContent = val;
                    }

                    // 4) UI mode
                    display.textContent = val;
                    edit.style.display = 'none';
                    view.style.display = 'flex';

                    // 5) Cache invalidate (dashboard tenant adı kullanıyor)
                    if (window.ViewCache && typeof window.ViewCache.invalidate === 'function') {
                        try { window.ViewCache.invalidate(''); } catch (e) { /* noop */ }
                    }

                    // 6) Notify
                    try { window.dispatchEvent(new CustomEvent('tenant:updated', { detail: { name: val } })); } catch (e) { /* noop */ }

                    if (window.Toast && Toast.success) Toast.success('İşletme adı güncellendi');
                } catch (err) {
                    if (window.Toast && Toast.error) Toast.error((err && err.message) || 'Kaydetme başarısız');
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Kaydet';
                }
            };
        }

    },

    escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    escapeAttr(str) {
        return this.escapeHtml(str);
    },

    /* ============================================================
       LAST BACKUP — localStorage tabanlı
    ============================================================ */

    _getLastBackupDate() {
        try {
            return localStorage.getItem('last_backup_date') || '';
        } catch (e) {
            return '';
        }
    },

    _setLastBackupDate() {
        try {
            var d = new Date();
            var dd = String(d.getDate()).padStart(2, '0');
            var mm = String(d.getMonth() + 1).padStart(2, '0');
            var yyyy = d.getFullYear();
            var formatted = dd + '.' + mm + '.' + yyyy;
            localStorage.setItem('last_backup_date', formatted);
            return formatted;
        } catch (e) {
            return '';
        }
    },

    _renderLastBackupHtml() {
        var stored = this._getLastBackupDate();
        if (stored) {
            return '<div id="settingsLastBackup" style="margin-top:3px;line-height:1.15;">' +
                '<div style="font-size:13px;font-weight:700;color:#0f172a;">' + this.escapeHtml(stored) + '</div>' +
                '<div style="margin-top:1px;font-size:10px;font-weight:700;color:#16a34a;letter-spacing:0.06em;">YEDEK ALINDI</div>' +
                '</div>';
        }
        return '<div id="settingsLastBackup" style="margin-top:3px;font-size:13px;font-weight:600;color:#94a3b8;">Yedek Yok</div>';
    },

    _refreshLastBackupDisplay() {
        var el = document.getElementById('settingsLastBackup');
        if (!el || !el.parentElement) return;
        el.outerHTML = this._renderLastBackupHtml();
    },

    /* ============================================================
       RESTORE CONFIRM MODAL
    ============================================================ */

    _confirmRestore() {
        return new Promise(function (resolve) {
            var existing = document.getElementById('settingsRestoreConfirmOverlay');
            if (existing && existing.parentElement) {
                existing.parentElement.removeChild(existing);
            }

            var overlay = document.createElement('div');
            overlay.id = 'settingsRestoreConfirmOverlay';
            overlay.style.cssText = '' +
                'position:fixed;inset:0;background:rgba(15,23,42,0.55);' +
                'z-index:10000;display:flex;align-items:center;justify-content:center;' +
                'padding:20px;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);' +
                'opacity:0;transition:opacity .18s ease;';

            overlay.innerHTML =
                '<div style="' +
                    'max-width:440px;width:100%;background:#ffffff;border-radius:18px;' +
                    'box-shadow:0 25px 80px rgba(15,23,42,0.22);overflow:hidden;' +
                    'transform:translateY(8px) scale(.98);transition:transform .18s ease;' +
                '">' +
                    '<div style="padding:24px 26px 18px;">' +
                        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
                            '<div style="width:40px;height:40px;border-radius:12px;background:#fef3c7;display:flex;align-items:center;justify-content:center;">' +
                                '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#b45309" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
                                    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
                                    '<line x1="12" y1="9" x2="12" y2="13"/>' +
                                    '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
                                '</svg>' +
                            '</div>' +
                            '<div style="font-size:17px;font-weight:800;color:#0f172a;letter-spacing:-0.01em;">Yedeği Geri Yükle</div>' +
                        '</div>' +
                        '<p style="margin:0;color:#475569;font-size:14px;line-height:1.55;">' +
                            'Bu işlem mevcut verilerin üzerine yazacaktır. Devam etmek istiyor musunuz?' +
                        '</p>' +
                    '</div>' +
                    '<div style="padding:14px 22px 22px;display:flex;justify-content:flex-end;gap:10px;">' +
                        '<button id="settingsRestoreCancelBtn" type="button" ' +
                            'style="padding:10px 18px;border:1px solid #e5e7eb;background:#ffffff;color:#475569;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;">' +
                            'İptal' +
                        '</button>' +
                        '<button id="settingsRestoreConfirmBtn" type="button" ' +
                            'style="padding:10px 18px;border:none;background:#0f172a;color:#ffffff;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;">' +
                            'Devam Et' +
                        '</button>' +
                    '</div>' +
                '</div>';

            document.body.appendChild(overlay);

            requestAnimationFrame(function () {
                overlay.style.opacity = '1';
                var card = overlay.firstElementChild;
                if (card) card.style.transform = 'translateY(0) scale(1)';
            });

            function cleanup(result) {
                overlay.style.opacity = '0';
                document.removeEventListener('keydown', onKey);
                setTimeout(function () {
                    if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
                    resolve(result);
                }, 160);
            }

            function onKey(e) {
                if (e.key === 'Escape') cleanup(false);
                if (e.key === 'Enter')  cleanup(true);
            }

            var cancel  = overlay.querySelector('#settingsRestoreCancelBtn');
            var confirm = overlay.querySelector('#settingsRestoreConfirmBtn');

            if (cancel)  cancel.onclick  = function () { cleanup(false); };
            if (confirm) confirm.onclick = function () { cleanup(true);  };

            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) cleanup(false);
            });

            document.addEventListener('keydown', onKey);
        });
    },

    renderVeri() {
        var body = '' +
            '<p style="margin:0 0 16px 0;color:#64748b;font-size:13px;line-height:1.55;">' +
                'Tüm işletme verilerinizi tek bir JSON dosyası olarak indirin veya önceki bir yedeği geri yükleyin. Geri yükleme mevcut tenant verisinin üzerine yazar.' +
            '</p>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
                '<button id="btnBackupExport" type="button" style="padding:11px 18px;border:none;background:#0f172a;color:#fff;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">Yedeği İndir</button>' +
                '<button id="btnBackupImport" type="button" style="padding:11px 18px;border:1px solid #e5e7eb;background:#fff;color:#0f172a;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;">Yedekten Geri Yükle</button>' +
            '</div>';

        var infoBlock = '' +
            '<div style="margin-top:18px;padding:18px 20px;border:1px solid #e5e7eb;border-radius:14px;background:#f8fafc;">' +
                '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
                    '<div style="width:28px;height:28px;border-radius:8px;background:#e0f2fe;display:flex;align-items:center;justify-content:center;">' +
                        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0369a1" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
                            '<circle cx="12" cy="12" r="10"/>' +
                            '<line x1="12" y1="16" x2="12" y2="12"/>' +
                            '<line x1="12" y1="8" x2="12.01" y2="8"/>' +
                        '</svg>' +
                    '</div>' +
                    '<div style="font-size:13.5px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">Yedek İçeriği</div>' +
                '</div>' +
                '<ul style="margin:0;padding:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px 18px;">' +
                    '<li style="font-size:13px;color:#475569;display:flex;align-items:center;gap:8px;"><span style="width:4px;height:4px;border-radius:50%;background:#94a3b8;"></span>Satışlar</li>' +
                    '<li style="font-size:13px;color:#475569;display:flex;align-items:center;gap:8px;"><span style="width:4px;height:4px;border-radius:50%;background:#94a3b8;"></span>Giderler</li>' +
                    '<li style="font-size:13px;color:#475569;display:flex;align-items:center;gap:8px;"><span style="width:4px;height:4px;border-radius:50%;background:#94a3b8;"></span>Ürünler</li>' +
                    '<li style="font-size:13px;color:#475569;display:flex;align-items:center;gap:8px;"><span style="width:4px;height:4px;border-radius:50%;background:#94a3b8;"></span>Hammaddeler</li>' +
                    '<li style="font-size:13px;color:#475569;display:flex;align-items:center;gap:8px;"><span style="width:4px;height:4px;border-radius:50%;background:#94a3b8;"></span>Reçeteler</li>' +
                    '<li style="font-size:13px;color:#475569;display:flex;align-items:center;gap:8px;"><span style="width:4px;height:4px;border-radius:50%;background:#94a3b8;"></span>Satış Detayları</li>' +
                '</ul>' +
                '<p style="margin:14px 0 0;font-size:12px;color:#94a3b8;line-height:1.5;">Yedekler mevcut tenant verilerini kapsar.</p>' +
            '</div>';

        return this.sectionCard('Yedekleme', 'Veri export / import', body + infoBlock);
    },

    renderAktarma() {
        return '' +
            '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px 24px;">' +
                '<div style="margin-bottom:16px;">' +
                    '<h3 style="margin:0;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:-0.01em;">Excel Veri Aktarımı</h3>' +
                    '<p style="margin:4px 0 0;color:#64748b;font-size:13px;">Şablon indirin, satış verilerinizi doldurun ve toplu olarak yükleyin.</p>' +
                '</div>' +
                '<div id="settingsTransferMount"></div>' +
            '</div>';
    },

    renderSistem() {
        var version = (window.APP_VERSION || '1.0.0');
        var body = '' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid #f1f5f9;">' +
                '<div>' +
                    '<div style="font-size:14px;font-weight:600;color:#0f172a;">Cache Temizle</div>' +
                    '<div style="margin-top:3px;font-size:13px;color:#64748b;">Yerel görünüm önbelleğini sıfırla</div>' +
                '</div>' +
                '<button id="btnSystemClearCache" type="button" style="padding:9px 14px;border:1px solid #e5e7eb;background:#fff;color:#0f172a;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;">Temizle</button>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid #f1f5f9;">' +
                '<div>' +
                    '<div style="font-size:14px;font-weight:600;color:#0f172a;">Sistem Durumu</div>' +
                    '<div style="margin-top:3px;font-size:13px;color:#64748b;">Bağlantı ve servisler</div>' +
                '</div>' +
                '<span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#16a34a;">' +
                    '<span style="width:8px;height:8px;border-radius:50%;background:#16a34a;"></span> Çalışıyor' +
                '</span>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:14px;padding:14px 0;">' +
                '<div>' +
                    '<div style="font-size:14px;font-weight:600;color:#0f172a;">Versiyon</div>' +
                    '<div style="margin-top:3px;font-size:13px;color:#64748b;">Uygulama sürüm bilgisi</div>' +
                '</div>' +
                '<span style="font-size:13px;font-weight:600;color:#475569;font-family:ui-monospace,monospace;">v' + version + '</span>' +
            '</div>';

        // Bind cache clear after innerHTML rendered
        setTimeout(function () {
            var btn = document.getElementById('btnSystemClearCache');
            if (btn) {
                btn.onclick = function () {
                    try {
                        if (window.ViewCache && typeof window.ViewCache.invalidate === 'function') {
                            window.ViewCache.invalidate('');
                        }
                        if (window.Toast && Toast.success) Toast.success('Önbellek temizlendi');
                    } catch (e) {
                        if (window.Toast && Toast.error) Toast.error('Önbellek temizlenemedi');
                    }
                };
            }
        }, 0);

        return this.sectionCard('Sistem', 'Önbellek, durum ve versiyon', body);
    },

    /* ============================================================
       BACKUP / TRANSFER (logic preserved)
    ============================================================ */

    bindBackupEvents() {
        const exportBtn = document.getElementById('btnBackupExport');
        const importBtn = document.getElementById('btnBackupImport');

        if (exportBtn) {
            exportBtn.onclick = async () => {
                if (!window.ImportExport || typeof window.ImportExport.exportAll !== 'function') {
                    if (window.Toast) Toast.error('Yedekleme modülü yüklenemedi');
                    return;
                }
                exportBtn.disabled = true;
                try {
                    const r = await window.ImportExport.exportAll();
                    if (!r.ok) {
                        if (window.Toast) Toast.error(r.error || 'Export failed');
                    } else {
                        this._setLastBackupDate();
                        this._refreshLastBackupDisplay();
                        if (window.Toast) Toast.success('Yedek indirildi');
                    }
                } finally {
                    exportBtn.disabled = false;
                }
            };
        }

        if (importBtn) {
            importBtn.onclick = async () => {
                if (!window.ImportExport || typeof window.ImportExport.importAll !== 'function') {
                    if (window.Toast) Toast.error('Yedekleme modülü yüklenemedi');
                    return;
                }
                const file = await window.ImportExport.pickBackupFile();
                if (!file) return;

                const confirmed = await this._confirmRestore();
                if (!confirmed) return;

                importBtn.disabled = true;
                try {
                    const r = await window.ImportExport.importAll(file);
                    if (!r.ok) {
                        if (window.Toast) Toast.error(r.error || 'Import failed');
                    } else {
                        const ins = r.inserted || {};
                        const skp = r.skipped  || {};
                        const insTotal = Number(r.insertedTotal || 0);
                        const skpTotal = Number(r.skippedTotal  || 0);

                        let mainLine = (ins.sales || 0) + ' satış eklendi';
                        if (skpTotal > 0) {
                            mainLine += ' | ' + skpTotal + ' kayıt zaten mevcuttu, atlandı';
                        }

                        const parts = [];
                        if ((ins.products || 0)      || (skp.products || 0))      parts.push('Ürünler: '   + (ins.products||0)      + ' eklendi, ' + (skp.products||0)      + ' atlandı');
                        if ((ins.sales || 0)         || (skp.sales || 0))         parts.push('Satışlar: '  + (ins.sales||0)         + ' eklendi, ' + (skp.sales||0)         + ' atlandı');
                        if ((ins.product_sales || 0) || (skp.product_sales || 0)) parts.push('Ürün-Satış: '+ (ins.product_sales||0) + ' eklendi, ' + (skp.product_sales||0) + ' atlandı');
                        if ((ins.expenses || 0)      || (skp.expenses || 0))      parts.push('Giderler: '  + (ins.expenses||0)      + ' eklendi, ' + (skp.expenses||0)      + ' atlandı');

                        const fullMessage = parts.length ? mainLine + '\n' + parts.join('\n') : mainLine;

                        if (window.Toast) {
                            if (insTotal > 0) {
                                Toast.success(fullMessage);
                            } else if (skpTotal > 0) {
                                Toast.info ? Toast.info(fullMessage) : Toast.success(fullMessage);
                            } else {
                                Toast.success('Yedek geri yüklendi (boş)');
                            }
                        }

                        if (insTotal > 0) {
                            setTimeout(() => location.reload(), 2500);
                        }
                    }
                } finally {
                    importBtn.disabled = false;
                }
            };
        }
    },

    mountTransfer() {
        if (this._transferMounted) return;

        const mount = document.getElementById('settingsTransferMount');
        if (!mount) return;
        if (!window.TransferView || typeof window.TransferView.render !== 'function') return;

        window.TransferView.render(mount);
        this._stripDuplicateBackupUI(mount);
        this._transferMounted = true;
    },

    _stripDuplicateBackupUI(mount) {
        const dlBtn = mount.querySelector('#downloadBackupBtn');
        if (dlBtn && dlBtn.parentElement) {
            dlBtn.parentElement.removeChild(dlBtn);
        }

        const restoreBtn = mount.querySelector('#restoreBackupBtn');
        if (restoreBtn) {
            let el = restoreBtn;
            while (el && el.parentElement && !el.parentElement.matches('section.transfer-page')) {
                el = el.parentElement;
            }
            if (el && el.parentElement) {
                el.parentElement.removeChild(el);
            }
        }
    },

    destroy() {
        if (window.TransferView && typeof window.TransferView.destroy === 'function') {
            try { window.TransferView.destroy(); } catch (e) { /* ignore */ }
        }
        this._transferMounted = false;
    }
};
