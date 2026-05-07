/* ============================================================
   RAW MATERIALS VIEW — Ham Madde yönetimi (list-first)
   - Üst toolbar: + Yeni Hammadde | Arama | Sıralama
   - Form accordion ile gizli, butonla açılır
   - cost: WAC ile alış sırasında otomatik dolar (manuel girilmez)
   ============================================================ */

window.RawMaterialsView = {
    materials: [],
    filteredMaterials: [],
    editingId: null,
    formOpen: false,
    searchTerm: '',
    sortKey: 'name_asc',
    _isActive: false,
    _listeners: [],

    UNIT_OPTIONS: ['gr', 'kg', 'ml', 'lt', 'cl', 'adet', 'paket'],
    VAT_OPTIONS: [0, 1, 10, 20],

    SORT_OPTIONS: [
        { key: 'name_asc',  label: 'A → Z' },
        { key: 'name_desc', label: 'Z → A' },
        { key: 'cost_desc', label: 'En pahalı' },
        { key: 'cost_asc',  label: 'En ucuz' },
        { key: 'recent',    label: 'Son eklenen' }
    ],

    async render(container) {
        this._isActive = true;
        this.editingId = null;
        this.formOpen = false;
        this.searchTerm = '';
        this.sortKey = 'name_asc';

        var unitOptionsHtml = this.UNIT_OPTIONS.map(function (u) {
            return '<option value="' + u + '">' + u + '</option>';
        }).join('');

        var vatOptionsHtml = this.VAT_OPTIONS.map(function (v) {
            var sel = (v === 20) ? ' selected' : '';
            return '<option value="' + v + '"' + sel + '>%' + v + '</option>';
        }).join('');

        var sortOptionsHtml = this.SORT_OPTIONS.map(function (o) {
            return '<option value="' + o.key + '">' + o.label + '</option>';
        }).join('');

        container.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:4px 0 18px 0;">
                <div>
                    <h2 style="margin:0 0 6px 0;font-size:28px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;">Ham Maddeler</h2>
                    <p style="margin:0;color:#64748b;font-size:14px;">Hammadde listesi ve KDV/birim yönetimi</p>
                </div>
                <button id="rawMatToggleFormBtn" type="button" style="
                    border:none;background:#0f172a;color:#fff;padding:12px 18px;
                    border-radius:12px;font-weight:700;cursor:pointer;font-size:14px;
                    display:inline-flex;align-items:center;gap:8px;
                ">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Yeni Hammadde
                </button>
            </div>

            <!-- TOOLBAR: search + sort -->
            <div style="
                background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;
                padding:14px 16px;margin-bottom:14px;
                display:flex;gap:12px;flex-wrap:wrap;align-items:center;
            ">
                <div style="flex:1;min-width:220px;position:relative;">
                    <svg style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#94a3b8;" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input id="rawMatSearch" type="text" placeholder="Hammadde ara..." style="
                        width:100%;padding:10px 12px 10px 36px;border:1px solid #e5e7eb;border-radius:10px;
                        font-size:13.5px;color:#0f172a;background:#ffffff;box-sizing:border-box;font-family:inherit;
                    ">
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12.5px;font-weight:600;color:#64748b;">Sırala</label>
                    <select id="rawMatSort" style="
                        padding:10px 12px;border:1px solid #e5e7eb;border-radius:10px;
                        font-size:13.5px;color:#0f172a;background:#ffffff;font-family:inherit;cursor:pointer;
                    ">${sortOptionsHtml}</select>
                </div>
            </div>

            <!-- FORM PANEL (accordion) -->
            <div id="rawMatFormPanel" style="
                display:none;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;
                padding:18px 20px;margin-bottom:14px;
            ">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
                    <h3 id="rawMatFormTitle" style="margin:0; font-size:15px; font-weight:800; color:#0f172a; letter-spacing:-0.01em;">Yeni Hammadde</h3>
                    <button id="rawMatCloseFormBtn" type="button" style="border:none;background:#f1f5f9;color:#475569;width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:16px;font-weight:700;">&times;</button>
                </div>

                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
                    <div>
                        <label style="display:block;font-size:12.5px;font-weight:600;color:#475569;margin-bottom:5px;">Ad</label>
                        <input id="rawMatName" type="text" placeholder="Örn: Sığır Eti" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;color:#0f172a;background:#fff;box-sizing:border-box;font-family:inherit;">
                    </div>
                    <div>
                        <label style="display:block;font-size:12.5px;font-weight:600;color:#475569;margin-bottom:5px;">Birim</label>
                        <select id="rawMatUnit" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;color:#0f172a;background:#fff;font-family:inherit;">${unitOptionsHtml}</select>
                    </div>
                    <div>
                        <label style="display:block;font-size:12.5px;font-weight:600;color:#475569;margin-bottom:5px;">KDV Oranı</label>
                        <select id="rawMatVat" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:10px;font-size:14px;color:#0f172a;background:#fff;font-family:inherit;">${vatOptionsHtml}</select>
                    </div>
                    <div>
                        <label style="display:block;font-size:12.5px;font-weight:600;color:#475569;margin-bottom:5px;">Birim Maliyet (₺)</label>
                        <input id="rawMatCost" type="number" placeholder="0.00" step="0.0001" min="0" disabled style="width:100%;padding:10px 12px;border:1px solid #e5e7eb;border-radius:10px;font-size:14px;color:#94a3b8;background:#f8fafc;cursor:not-allowed;box-sizing:border-box;font-family:inherit;">
                    </div>
                </div>

                <div style="margin-top:8px; font-size:12px; color:#94a3b8;line-height:1.5;">
                    <div>Alış birimi (kg / lt / adet) seçilir; sistem hesapları otomatik olarak <b>base birim</b> üzerinden yapar (kg → gr, lt → ml).</div>
                    <div style="margin-top:2px;">Birim maliyet alışlardan otomatik hesaplanır (WAC). Manuel girilmez.</div>
                </div>

                <div style="margin-top:14px; display:flex; gap:8px; justify-content:flex-end;">
                    <button id="rawMatCancelBtn" type="button" style="padding:10px 16px;border:1px solid #e5e7eb;background:#fff;color:#475569;border-radius:10px;font-size:13.5px;font-weight:600;cursor:pointer;">İptal</button>
                    <button id="rawMatSaveBtn" type="button" style="padding:10px 18px;border:none;background:#0f172a;color:#fff;border-radius:10px;font-size:13.5px;font-weight:700;cursor:pointer;">Kaydet</button>
                </div>
            </div>

            <div id="rawMatStatus" style="margin-bottom:12px;"></div>

            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
                <div style="overflow-x:auto;">
                    <table style="width:100%;border-collapse:collapse;">
                        <thead>
                            <tr style="background:#f8fafc;">
                                <th style="padding:14px 16px;text-align:left;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Ad</th>
                                <th style="padding:14px 16px;text-align:left;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Alış / Hesap</th>
                                <th style="padding:14px 16px;text-align:center;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">KDV</th>
                                <th style="padding:14px 16px;text-align:right;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;">Birim Maliyet</th>
                                <th style="padding:14px 16px;text-align:center;font-size:12px;font-weight:800;color:#64748b;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:0.5px;width:160px;">İşlemler</th>
                            </tr>
                        </thead>
                        <tbody id="rawMatTableBody">
                            <tr><td colspan="5" style="text-align:center;padding:24px;color:#94a3b8;">Yükleniyor...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        this.bindEvents();

        // === CACHE INVALIDATION HANDLER (sadece bir kez) ===
        if (!this._cacheEventsBound) {
            this._cacheEventsBound = true;
            window.addEventListener('products:updated', function () {
                if (window.ViewCache) window.ViewCache.invalidate('raw-materials:');
            });
            window.addEventListener('raw-materials:updated', function () {
                if (window.ViewCache) window.ViewCache.invalidate('raw-materials:');
            });
        }

        // === CACHE READ ===
        var tid = (window.STATE && window.STATE.tenant && window.STATE.tenant.id) || '';
        var cacheKey = 'raw-materials:' + tid;
        if (window.ViewCache) {
            var cached = window.ViewCache.get(cacheKey);
            if (cached && Array.isArray(cached.materials)) {
                this.materials = cached.materials;
                this.applyFiltersAndRender();
                return;
            }
        }

        await this.loadMaterials();

        // === CACHE WRITE ===
        if (window.ViewCache && Array.isArray(this.materials)) {
            window.ViewCache.set(cacheKey, { materials: this.materials }, 60 * 1000);
        }
    },

    bindEvents() {
        var self = this;

        var toggleBtn  = document.getElementById('rawMatToggleFormBtn');
        var closeBtn   = document.getElementById('rawMatCloseFormBtn');
        var cancelBtn  = document.getElementById('rawMatCancelBtn');
        var saveBtn    = document.getElementById('rawMatSaveBtn');
        var searchEl   = document.getElementById('rawMatSearch');
        var sortEl     = document.getElementById('rawMatSort');

        if (toggleBtn) toggleBtn.onclick = function () { self.openForm(); };
        if (closeBtn)  closeBtn.onclick  = function () { self.closeForm(); };
        if (cancelBtn) cancelBtn.onclick = function () { self.closeForm(); };
        if (saveBtn)   saveBtn.onclick   = function () { self.save(); };

        if (searchEl) {
            searchEl.oninput = function (e) {
                self.searchTerm = String(e.target.value || '').trim();
                self.applyFiltersAndRender();
            };
        }
        if (sortEl) {
            sortEl.onchange = function (e) {
                self.sortKey = e.target.value;
                self.applyFiltersAndRender();
            };
        }
    },

    openForm() {
        this.formOpen = true;
        var panel = document.getElementById('rawMatFormPanel');
        var title = document.getElementById('rawMatFormTitle');
        if (panel) panel.style.display = 'block';
        if (!this.editingId) {
            this.clearForm();
            if (title) title.textContent = 'Yeni Hammadde';
        }
        var nameEl = document.getElementById('rawMatName');
        if (nameEl) setTimeout(function () { nameEl.focus(); }, 30);
    },

    closeForm() {
        this.formOpen = false;
        this.editingId = null;
        this.clearForm();
        var panel = document.getElementById('rawMatFormPanel');
        if (panel) panel.style.display = 'none';
    },

    loadMaterials: async function () {
        var tbody = document.getElementById('rawMatTableBody');
        if (!tbody) return;

        try {
            if (!window.SupabaseService || typeof window.SupabaseService.query !== 'function') {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px; color:#dc2626;">SupabaseService yüklenemedi.</td></tr>';
                this.setStatus('SupabaseService yüklenemedi.', 'error');
                return;
            }

            var result = await window.SupabaseService.query('raw_materials', {
                filters: [{ op: 'eq', column: 'is_deleted', value: false }],
                order: { column: 'name', asc: true },
                select: 'id,name,unit,base_unit,cost,vat_rate,is_active,created_at'
            });
            if (!this._isActive) return;

            if (result.error) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px; color:#dc2626;">Ham maddeler yüklenemedi.</td></tr>';
                this.setStatus(this.getErrorMessage(result.error, 'raw_materials okunamadı.'), 'error');
                return;
            }

            this.materials = Array.isArray(result.data) ? result.data : [];
            this.applyFiltersAndRender();
        } catch (error) {
            if (!this._isActive) return;
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px; color:#dc2626;">Beklenmeyen hata.</td></tr>';
            this.setStatus(this.getErrorMessage(error, 'Beklenmeyen hata.'), 'error');
        }
    },

    applyFiltersAndRender() {
        var term = this.normalizeName(this.searchTerm);
        var self = this;

        var filtered = (this.materials || []).slice();
        if (term) {
            filtered = filtered.filter(function (m) {
                return self.normalizeName(m.name).indexOf(term) !== -1;
            });
        }

        switch (this.sortKey) {
            case 'name_desc':
                filtered.sort(function (a, b) { return String(b.name || '').localeCompare(String(a.name || ''), 'tr'); });
                break;
            case 'cost_desc':
                filtered.sort(function (a, b) { return Number(b.cost || 0) - Number(a.cost || 0); });
                break;
            case 'cost_asc':
                filtered.sort(function (a, b) { return Number(a.cost || 0) - Number(b.cost || 0); });
                break;
            case 'recent':
                filtered.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
                break;
            case 'name_asc':
            default:
                filtered.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'tr'); });
        }

        this.filteredMaterials = filtered;
        this.renderTable();
    },

    renderTable() {
        var tbody = document.getElementById('rawMatTableBody');
        if (!tbody) return;

        var rows = this.filteredMaterials || [];

        if (!rows.length) {
            var msg = (this.materials && this.materials.length)
                ? 'Aramaya uyan hammadde bulunamadı.'
                : 'Henüz ham madde yok. "Yeni Hammadde" ile ekleyebilirsin.';
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:32px; color:#94a3b8;">' + msg + '</td></tr>';
            return;
        }

        var self = this;

        tbody.innerHTML = rows.map(function (m) {
            var name = self.escapeHtml(m.name || '-');
            var purchaseUnit = self.escapeHtml(m.unit || '-');
            var baseUnit = self.escapeHtml(m.base_unit || m.unit || '-');
            var unitDisplay = (m.base_unit && m.base_unit !== m.unit)
                ? purchaseUnit + ' <span style="color:#94a3b8;">→</span> ' + baseUnit
                : purchaseUnit;
            var vat  = (m.vat_rate != null) ? Number(m.vat_rate) : 20;
            var cost = self.formatMoney(m.cost) + ' / ' + baseUnit;
            var id   = self.escapeHtml(m.id);

            return '<tr style="border-bottom:1px solid #f1f5f9;">' +
                '<td style="padding:14px 16px;font-weight:600;color:#0f172a;">' + name + '</td>' +
                '<td style="padding:14px 16px;color:#475569;font-weight:600;">' + unitDisplay + '</td>' +
                '<td style="padding:14px 16px;text-align:center;font-weight:600;color:#475569;">%' + vat + '</td>' +
                '<td style="padding:14px 16px;text-align:right;font-weight:700;color:#0f172a;">' + cost + '</td>' +
                '<td style="padding:14px 16px;text-align:center;">' +
                    '<div style="display:inline-flex; gap:6px; flex-wrap:wrap; justify-content:center;">' +
                        '<button type="button" style="padding:6px 12px;border:1px solid #e5e7eb;background:#fff;color:#0f172a;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;" onclick="window.RawMaterialsView.editMaterial(\'' + id + '\')">Düzenle</button>' +
                        '<button type="button" style="padding:6px 12px;border:1px solid #fecaca;background:#fff;color:#b91c1c;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;" onclick="window.RawMaterialsView.remove(\'' + id + '\')">Sil</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';
        }).join('');
    },

    editMaterial: function (id) {
        var m = this.materials.find(function (x) { return String(x.id) === String(id); });
        if (!m) {
            this.setStatus('Ham madde bulunamadı.', 'error');
            return;
        }

        this.editingId = m.id;

        var nameEl = document.getElementById('rawMatName');
        var unitEl = document.getElementById('rawMatUnit');
        var vatEl  = document.getElementById('rawMatVat');
        var costEl = document.getElementById('rawMatCost');
        var title  = document.getElementById('rawMatFormTitle');

        if (nameEl) nameEl.value = m.name || '';
        if (unitEl) unitEl.value = m.unit || 'gr';
        if (vatEl)  vatEl.value  = (m.vat_rate != null ? String(m.vat_rate) : '20');
        if (costEl) costEl.value = Number(m.cost) || 0;
        if (title)  title.textContent = 'Hammadde Düzenle';

        this.openForm();
        var panel = document.getElementById('rawMatFormPanel');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    clearForm: function () {
        var nameEl = document.getElementById('rawMatName');
        var unitEl = document.getElementById('rawMatUnit');
        var vatEl  = document.getElementById('rawMatVat');
        var costEl = document.getElementById('rawMatCost');

        if (nameEl) nameEl.value = '';
        if (unitEl) unitEl.value = 'gr';
        if (vatEl)  vatEl.value  = '20';
        if (costEl) costEl.value = '';
    },

    save: async function () {
        var nameEl = document.getElementById('rawMatName');
        var unitEl = document.getElementById('rawMatUnit');
        var vatEl  = document.getElementById('rawMatVat');

        var name = nameEl ? String(nameEl.value || '').trim() : '';
        var unit = unitEl ? String(unitEl.value || '').trim() : '';
        var vat  = vatEl  ? Number(vatEl.value)  : 20;

        var errors = [];
        if (!name) errors.push('Ad zorunludur.');
        if (this.UNIT_OPTIONS.indexOf(unit) === -1) errors.push('Geçerli bir birim seç.');
        if (!Number.isFinite(vat) || vat < 0 || vat > 100) errors.push('KDV oranı 0-100 arası olmalı.');

        if (errors.length) {
            this.setStatus(errors.join(' '), 'error');
            return;
        }

        if (!window.SupabaseService || !window.SupabaseService.isConnected()) {
            this.setStatus('Supabase bağlı değil.', 'error');
            return;
        }

        var self = this;

        var duplicate = this.materials.some(function (m) {
            if (self.editingId && String(m.id) === String(self.editingId)) return false;
            return self.normalizeName(m.name) === self.normalizeName(name);
        });
        if (duplicate) {
            this.setStatus('Aynı isimde hammadde zaten var.', 'error');
            return;
        }

        var response;

        if (this.editingId) {
            response = await window.SupabaseService.update('raw_materials', this.editingId, {
                name: name, unit: unit, vat_rate: vat
            });
        } else {
            response = await window.SupabaseService.insert('raw_materials', {
                name: name, unit: unit, cost: 0, vat_rate: vat
            });
        }
        if (!this._isActive) return;

        if (response && response.error) {
            this.setStatus(this.getErrorMessage(response.error, 'Hammadde kaydedilemedi.'), 'error');
            return;
        }

        var msg = this.editingId ? 'Hammadde güncellendi.' : 'Hammadde eklendi.';
        if (window.Toast && Toast.success) Toast.success(msg);
        this.editingId = null;
        this.closeForm();
        try { window.dispatchEvent(new Event('raw-materials:updated')); } catch (e) {}
        await this.loadMaterials();
    },

    remove: async function (id) {
        var m = this.materials.find(function (x) { return String(x.id) === String(id); });
        if (!m) {
            this.setStatus('Hammadde bulunamadı.', 'error');
            return;
        }

        var ok = window.confirm('"' + (m.name || '') + '" hammaddesi silinsin mi?');
        if (!ok) return;

        var response = await window.SupabaseService.update('raw_materials', id, {
            is_deleted: true,
            is_active: false
        });
        if (!this._isActive) return;

        if (response && response.error) {
            this.setStatus(this.getErrorMessage(response.error, 'Hammadde silinemedi.'), 'error');
            return;
        }

        if (this.editingId && String(this.editingId) === String(id)) {
            this.closeForm();
        }

        if (window.Toast && Toast.success) Toast.success('"' + (m.name || '') + '" silindi.');
        try { window.dispatchEvent(new Event('raw-materials:updated')); } catch (e) {}
        await this.loadMaterials();
    },

    /* ============================================================
       HELPERS
       ============================================================ */

    setStatus: function (message, type) {
        var el = document.getElementById('rawMatStatus');
        if (!el) return;

        // Sadece error mesajlari kalici gosterilir; success → toast
        if (type === 'success') {
            el.innerHTML = '';
            return;
        }

        el.innerHTML = '<div style="padding:12px 14px; border-radius:12px; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; font-size:13.5px; font-weight:600;">' + this.escapeHtml(message) + '</div>';
    },

    getErrorMessage: function (error, fallback) {
        if (!error) return fallback || 'Bilinmeyen hata.';
        if (typeof error === 'string') return error;
        if (typeof error.message === 'string' && error.message.trim()) return error.message;
        if (typeof error.details === 'string' && error.details.trim()) return error.details;
        if (typeof error.hint === 'string' && error.hint.trim()) return error.hint;
        try { return JSON.stringify(error); } catch (_) { return fallback || 'Bilinmeyen hata.'; }
    },

    formatMoney: function (value) {
        var number = Number(value) || 0;
        return '₺' + number.toLocaleString('tr-TR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 4
        });
    },

    normalizeName: function (value) {
        return String(value || '')
            .trim()
            .toLocaleLowerCase('tr-TR')
            .replace(/ı/g, 'i')
            .replace(/ğ/g, 'g')
            .replace(/ü/g, 'u')
            .replace(/ş/g, 's')
            .replace(/ö/g, 'o')
            .replace(/ç/g, 'c')
            .replace(/\s+/g, ' ');
    },

    escapeHtml: function (value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    destroy: function () {
        this._isActive = false;
        this.materials = [];
        this.filteredMaterials = [];
        this.editingId = null;
        this.formOpen = false;
    }
};
