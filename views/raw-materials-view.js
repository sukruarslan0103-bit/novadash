/* ============================================================
   RAW MATERIALS VIEW — Ham Madde yönetimi
   - Liste (name, unit, cost, vat_rate)
   - Ekle / Güncelle (name, unit, vat_rate) / Soft Delete
   - tenant_id → backend (set_tenant_id trigger + RLS) çözümler
   - cost: WAC ile alış sırasında otomatik dolar (manuel girilmez)
   - vat_rate: hammadde bazında varsayılan KDV; alış ekranında
              hammadde seçilince satıra otomatik atanır.
   ============================================================ */

window.RawMaterialsView = {
    materials: [],
    editingId: null,
    _isActive: false,
    _listeners: [],

    UNIT_OPTIONS: ['gr', 'kg', 'ml', 'lt', 'cl', 'adet', 'paket'],
    VAT_OPTIONS: [0, 1, 10, 20],

    async render(container) {
        this._isActive = true;
        this.editingId = null;

        var unitOptionsHtml = this.UNIT_OPTIONS.map(function (u) {
            return '<option value="' + u + '">' + u + '</option>';
        }).join('');

        var vatOptionsHtml = this.VAT_OPTIONS.map(function (v) {
            var sel = (v === 20) ? ' selected' : '';
            return '<option value="' + v + '"' + sel + '>%' + v + '</option>';
        }).join('');

        container.innerHTML = `
            <div class="page-header">
                <h2 class="page-title">Ham Maddeler</h2>
            </div>

            <div class="form-card" style="margin-top:12px;">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
                    <h3 id="rawMatFormTitle" style="margin:0; font-size:1rem; font-weight:700;">Ham Madde Ekle</h3>
                    <button class="btn btn-secondary" type="button" id="rawMatCancelBtn" style="display:none;" onclick="window.RawMaterialsView.cancelEdit()">İptal</button>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label">Ad</label>
                        <input type="text" class="form-input" id="rawMatName" placeholder="Örn: Sığır Eti">
                    </div>

                    <div class="form-group">
                        <label class="form-label">Birim</label>
                        <select class="form-select" id="rawMatUnit">
                            ${unitOptionsHtml}
                        </select>
                    </div>

                    <div class="form-group">
                        <label class="form-label">KDV Oranı</label>
                        <select class="form-select" id="rawMatVat">
                            ${vatOptionsHtml}
                        </select>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Birim Maliyet (₺)</label>
                        <input type="number" class="form-input" id="rawMatCost" placeholder="0.00" step="0.0001" min="0" disabled
                               style="background:#f1f5f9; color:#64748b; cursor:not-allowed;">
                    </div>
                </div>

                <div style="margin-top:6px; font-size:12px; color:#64748b;">
                    Birim maliyet alışlardan otomatik hesaplanır (WAC). Manuel girilmez.
                </div>

                <div style="margin-top:14px; display:flex; gap:10px;">
                    <button class="btn btn-primary" type="button" onclick="window.RawMaterialsView.save()">Kaydet</button>
                </div>
            </div>

            <div id="rawMatStatus" style="margin:16px 0;"></div>

            <div class="data-table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Ad</th>
                            <th>Birim</th>
                            <th style="text-align:center;">KDV</th>
                            <th style="text-align:right;">Birim Maliyet</th>
                            <th style="width:180px;">İşlemler</th>
                        </tr>
                    </thead>
                    <tbody id="rawMatTableBody">
                        <tr>
                            <td colspan="5" style="text-align:center; padding:24px;">Yükleniyor...</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        `;

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
                this.renderTable();
                this.setStatus(this.materials.length + ' ham madde yüklendi (cache).', 'success');
                return;
            }
        }

        await this.loadMaterials();

        // === CACHE WRITE ===
        if (window.ViewCache && Array.isArray(this.materials)) {
            window.ViewCache.set(cacheKey, { materials: this.materials }, 60 * 1000);
        }
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
                filters: [
                    { op: 'eq', column: 'is_deleted', value: false }
                ],
                order: { column: 'name', asc: true },
                select: 'id,name,unit,cost,vat_rate,is_active,created_at'
            });
            if (!this._isActive) return;

            if (result.error) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px; color:#dc2626;">Ham maddeler yüklenemedi.</td></tr>';
                this.setStatus(this.getErrorMessage(result.error, 'raw_materials okunamadı.'), 'error');
                return;
            }

            this.materials = Array.isArray(result.data) ? result.data : [];
            this.renderTable();
            this.setStatus(this.materials.length + ' ham madde yüklendi.', 'success');
        } catch (error) {
            if (!this._isActive) return;
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px; color:#dc2626;">Beklenmeyen hata.</td></tr>';
            this.setStatus(this.getErrorMessage(error, 'Beklenmeyen hata.'), 'error');
        }
    },

    renderTable: function () {
        var tbody = document.getElementById('rawMatTableBody');
        if (!tbody) return;

        if (!this.materials.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:24px; color:#64748b;">Henüz ham madde yok. Yukarıdan ekleyebilirsin.</td></tr>';
            return;
        }

        var self = this;

        tbody.innerHTML = this.materials.map(function (m) {
            var name = self.escapeHtml(m.name || '-');
            var unit = self.escapeHtml(m.unit || '-');
            var vat  = (m.vat_rate != null) ? Number(m.vat_rate) : 20;
            var cost = self.formatMoney(m.cost);
            var id   = self.escapeHtml(m.id);

            return '<tr>' +
                '<td>' + name + '</td>' +
                '<td>' + unit + '</td>' +
                '<td style="text-align:center; font-weight:600; color:#475569;">%' + vat + '</td>' +
                '<td style="text-align:right; font-weight:700;">' + cost + '</td>' +
                '<td>' +
                    '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
                        '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px;" onclick="window.RawMaterialsView.editMaterial(\'' + id + '\')">📌 Düzenle</button>' +
                        '<button class="btn btn-secondary" style="padding:6px 10px; font-size:12px; color:#b91c1c;" onclick="window.RawMaterialsView.remove(\'' + id + '\')">📌 Sil</button>' +
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
        var cancel = document.getElementById('rawMatCancelBtn');

        if (nameEl) nameEl.value = m.name || '';
        if (unitEl) unitEl.value = m.unit || 'gr';
        if (vatEl)  vatEl.value  = (m.vat_rate != null ? String(m.vat_rate) : '20');
        if (costEl) costEl.value = Number(m.cost) || 0;
        if (title)  title.textContent = 'Ham Madde Düzenle';
        if (cancel) cancel.style.display = '';

        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    cancelEdit: function () {
        this.editingId = null;
        this.clearForm();
    },

    clearForm: function () {
        var nameEl = document.getElementById('rawMatName');
        var unitEl = document.getElementById('rawMatUnit');
        var vatEl  = document.getElementById('rawMatVat');
        var costEl = document.getElementById('rawMatCost');
        var title  = document.getElementById('rawMatFormTitle');
        var cancel = document.getElementById('rawMatCancelBtn');

        if (nameEl) nameEl.value = '';
        if (unitEl) unitEl.value = 'gr';
        if (vatEl)  vatEl.value  = '20';
        if (costEl) costEl.value = '';
        if (title)  title.textContent = 'Ham Madde Ekle';
        if (cancel) cancel.style.display = 'none';
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

        // İstemci tarafı duplicate guard (DB'de partial unique var)
        var duplicate = this.materials.some(function (m) {
            if (self.editingId && String(m.id) === String(self.editingId)) return false;
            return self.normalizeName(m.name) === self.normalizeName(name);
        });
        if (duplicate) {
            this.setStatus('Aynı isimde ham madde zaten var.', 'error');
            return;
        }

        var response;

        if (this.editingId) {
            // Update — cost'a dokunma (WAC kontrolünde)
            response = await window.SupabaseService.update('raw_materials', this.editingId, {
                name: name,
                unit: unit,
                vat_rate: vat
            });
        } else {
            // Insert — cost 0 olarak başlar, ilk alışta WAC dolduracak
            response = await window.SupabaseService.insert('raw_materials', {
                name: name,
                unit: unit,
                cost: 0,
                vat_rate: vat
            });
        }
        if (!this._isActive) return;

        if (response && response.error) {
            this.setStatus(this.getErrorMessage(response.error, 'Ham madde kaydedilemedi.'), 'error');
            return;
        }

        this.setStatus(this.editingId ? 'Ham madde güncellendi.' : 'Ham madde eklendi.', 'success');
        this.editingId = null;
        this.clearForm();
        try { window.dispatchEvent(new Event('raw-materials:updated')); } catch (e) {}
        await this.loadMaterials();
    },

    remove: async function (id) {
        var m = this.materials.find(function (x) { return String(x.id) === String(id); });
        if (!m) {
            this.setStatus('Ham madde bulunamadı.', 'error');
            return;
        }

        var ok = window.confirm('"' + (m.name || '') + '" ham maddesi silinsin mi? (Soft delete)');
        if (!ok) return;

        var response = await window.SupabaseService.update('raw_materials', id, {
            is_deleted: true,
            is_active: false
        });
        if (!this._isActive) return;

        if (response && response.error) {
            this.setStatus(this.getErrorMessage(response.error, 'Ham madde silinemedi.'), 'error');
            return;
        }

        // Düzenleme aktifken silinirse formu temizle
        if (this.editingId && String(this.editingId) === String(id)) {
            this.editingId = null;
            this.clearForm();
        }

        this.setStatus('"' + (m.name || '') + '" silindi.', 'success');
        try { window.dispatchEvent(new Event('raw-materials:updated')); } catch (e) {}
        await this.loadMaterials();
    },

    /* ============================================================
       HELPERS
       ============================================================ */

    setStatus: function (message, type) {
        var el = document.getElementById('rawMatStatus');
        if (!el) return;

        if (type === 'success') {
            el.innerHTML = '<div style="padding:14px 16px; border-radius:14px; background:#ecfdf5; border:1px solid #86efac; color:#166534; font-size:14px; font-weight:600;">' + this.escapeHtml(message) + '</div>';
            return;
        }

        el.innerHTML = '<div style="padding:14px 16px; border-radius:14px; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; font-size:14px; font-weight:600;">' + this.escapeHtml(message) + '</div>';
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
        this.editingId = null;
    }
};
