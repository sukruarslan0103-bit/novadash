/* ============================================================
   views/transfer-view.js
   Aktarma ekrani
   View sadece render + event + sonuc gosterimi yapar
   ============================================================ */

window.TransferView = {
    previewRows: [],
    validatedRows: [],
    productMap: new Map(),
    _submitting: false,
    _importKey: null,
    _statusTimer: null,
    _previewResetTimer: null,
    _backupData: null,
    _restoring: false,
    _restoreStatusTimer: null,
    _listeners: [],
    _isActive: false,

    render(container) {
        container.innerHTML = `
            <section class="transfer-page">
                <div style="padding:4px 0 18px 0;">
                    <h2 style="margin:0 0 6px 0;font-size:28px;font-weight:800;color:#0f172a;">Aktarma</h2>
                    <p style="margin:0;color:#64748b;font-size:14px;">
                        Günlük satış verisini Excel şablonu ile içeri aktar.
                    </p>
                </div>

                <div style="
                    background:#ffffff;
                    border:1px solid #e5e7eb;
                    border-radius:20px;
                    box-shadow:0 10px 30px rgba(15,23,42,0.06);
                    padding:24px;
                ">
                    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:18px;">
                        <button id="downloadSalesTemplateBtn" type="button" style="
                            border:none;
                            background:#22c55e;
                            color:#fff;
                            padding:12px 18px;
                            border-radius:12px;
                            font-weight:700;
                            cursor:pointer;
                        ">
                            Satış Şablonu İndir
                        </button>

                        <label for="salesFileInput" style="
                            display:inline-flex;
                            align-items:center;
                            justify-content:center;
                            border:1px solid #d1d5db;
                            background:#f8fafc;
                            color:#334155;
                            padding:12px 18px;
                            border-radius:12px;
                            font-weight:700;
                            cursor:pointer;
                        ">
                            Excel Dosyası Seç
                        </label>

                        <input
                            id="salesFileInput"
                            type="file"
                            accept=".xls,.xlsx"
                            style="display:none;"
                        >

                        <button id="importSalesBtn" type="button" style="
                            border:none;
                            background:#0f172a;
                            color:#fff;
                            padding:12px 18px;
                            border-radius:12px;
                            font-weight:700;
                            cursor:pointer;
                        ">
                            Satışa Aktar
                        </button>

                        <button id="downloadBackupBtn" type="button" style="
                            border:none;
                            background:#2563eb;
                            color:#fff;
                            padding:12px 18px;
                            border-radius:12px;
                            font-weight:700;
                            cursor:pointer;
                        ">
                            Backup İndir
                        </button>
                    </div>

                    <div style="
                        margin-bottom:18px;
                        padding:14px 16px;
                        background:#f8fafc;
                        border:1px solid #e5e7eb;
                        border-radius:14px;
                        color:#334155;
                        line-height:1.6;
                        font-size:14px;
                    ">
                        <div><strong>Beklenen kolonlar:</strong> Tarih | Ürün Adı | Adet | Satış Tutarı</div>
                        <div><strong>Satış Tutarı:</strong> Birim fiyattır. Satır toplamı = Adet x Satış Tutarı</div>
                        <div><strong>Tarih formatı:</strong> 24.03.2026 veya 1.03.2026</div>
                        <div><strong>Dosya tipi:</strong> .xls veya .xlsx</div>
                        <div><strong>Kural:</strong> Ürün, products tablosunda yoksa aktarım yapılmaz.</div>
                    </div>

                    <div id="transferStatus" style="margin-bottom:18px;"></div>

                    <div style="
                        border:1px solid #e5e7eb;
                        border-radius:16px;
                        overflow:hidden;
                        background:#fff;
                    ">
                        <table style="width:100%;border-collapse:collapse;">
                            <thead>
                                <tr style="background:#f8fafc;">
                                    <th style="padding:14px 16px;text-align:left;font-size:13px;font-weight:800;color:#0f172a;border-bottom:1px solid #e5e7eb;">Tarih</th>
                                    <th style="padding:14px 16px;text-align:left;font-size:13px;font-weight:800;color:#0f172a;border-bottom:1px solid #e5e7eb;">Ürün Adı</th>
                                    <th style="padding:14px 16px;text-align:left;font-size:13px;font-weight:800;color:#0f172a;border-bottom:1px solid #e5e7eb;">Adet</th>
                                    <th style="padding:14px 16px;text-align:left;font-size:13px;font-weight:800;color:#0f172a;border-bottom:1px solid #e5e7eb;">Satış Tutarı</th>
                                </tr>
                            </thead>
                            <tbody id="transferPreviewBody">
                                <tr>
                                    <td colspan="4" style="padding:18px 16px;color:#94a3b8;font-size:14px;">
                                        Henüz dosya yüklenmedi.
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div style="
                    background:#ffffff;
                    border:1px solid #e5e7eb;
                    border-radius:20px;
                    box-shadow:0 10px 30px rgba(15,23,42,0.06);
                    padding:24px;
                    margin-top:24px;
                ">
                    <div style="margin-bottom:16px;">
                        <h3 style="margin:0 0 4px 0;font-size:17px;font-weight:800;color:#0f172a;">Backup Geri Yükle</h3>
                        <p style="margin:0;color:#64748b;font-size:13px;">
                            İndirilen backup.json dosyasını seçerek verileri geri yükle.
                        </p>
                    </div>

                    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:18px;">
                        <label for="backupFileInput" style="
                            display:inline-flex;
                            align-items:center;
                            justify-content:center;
                            border:1px solid #d1d5db;
                            background:#f8fafc;
                            color:#334155;
                            padding:12px 18px;
                            border-radius:12px;
                            font-weight:700;
                            cursor:pointer;
                        ">
                            JSON Dosyası Seç
                        </label>

                        <input
                            id="backupFileInput"
                            type="file"
                            accept=".json"
                            style="display:none;"
                        >

                        <button id="restoreBackupBtn" type="button" style="
                            border:none;
                            background:#7c3aed;
                            color:#fff;
                            padding:12px 18px;
                            border-radius:12px;
                            font-weight:700;
                            cursor:pointer;
                        ">
                            Geri Yükle
                        </button>
                    </div>

                    <div id="restoreStatus"></div>
                </div>
            </section>
        `;

        this._isActive = true;
        this.previewRows = [];
        this.validatedRows = [];
        this.productMap = new Map();
        this._submitting = false;
        this._importKey = null;
        this._backupData = null;
        this._restoring = false;

        if (this._statusTimer) {
            clearTimeout(this._statusTimer);
            this._statusTimer = null;
        }

        if (this._previewResetTimer) {
            clearTimeout(this._previewResetTimer);
            this._previewResetTimer = null;
        }

        this.bindEvents();
    },

    _on(el, event, fn) {
        if (!el) return;
        el.addEventListener(event, fn);
        this._listeners.push({ el: el, event: event, fn: fn });
    },

    _removeAllListeners() {
        for (var i = 0; i < this._listeners.length; i++) {
            var l = this._listeners[i];
            l.el.removeEventListener(l.event, l.fn);
        }
        this._listeners = [];
    },

    destroy() {
        this._isActive = false;
        this._removeAllListeners();

        if (this._statusTimer) {
            clearTimeout(this._statusTimer);
            this._statusTimer = null;
        }

        if (this._previewResetTimer) {
            clearTimeout(this._previewResetTimer);
            this._previewResetTimer = null;
        }

        if (this._restoreStatusTimer) {
            clearTimeout(this._restoreStatusTimer);
            this._restoreStatusTimer = null;
        }

        this.previewRows = [];
        this.validatedRows = [];
        this.productMap = new Map();
        this._backupData = null;
        this._submitting = false;
        this._restoring = false;
        this._importKey = null;
    },

    bindEvents() {
        this._removeAllListeners();

        var self = this;

        this._on(document.getElementById('downloadSalesTemplateBtn'), 'click', function () { self.downloadTemplate(); });
        this._on(document.getElementById('salesFileInput'), 'change', function (event) { self.handleExcelFile(event); });
        this._on(document.getElementById('importSalesBtn'), 'click', function () { self.importToDatabase(); });
        this._on(document.getElementById('downloadBackupBtn'), 'click', function () { self.downloadBackup(); });
        this._on(document.getElementById('backupFileInput'), 'change', function (event) { self.handleBackupFile(event); });
        this._on(document.getElementById('restoreBackupBtn'), 'click', function () { self.restoreFromBackup(); });
    },

    downloadTemplate() {
        const result = window.ImportExport.createSalesTemplate();

        if (!result.ok) {
            this.setStatus(result.message, 'error');
            return;
        }

        this.setStatus('Excel şablonu indirildi.', 'success');
    },

    async handleExcelFile(event) {
        const fileInput = document.getElementById('salesFileInput');
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        if (this._previewResetTimer) {
            clearTimeout(this._previewResetTimer);
            this._previewResetTimer = null;
        }

        this._importKey = null;

        const readResult = await window.ImportExport.readSalesExcel(file);
        if (!this._isActive) return;

        if (!readResult.ok) {
            if (readResult.rows && readResult.rows.length) {
                this.previewRows = readResult.rows;
                this.validatedRows = [];
                this.renderPreview(readResult.rows);
            } else {
                this.resetPreview();
            }

            if (fileInput) {
                fileInput.value = '';
            }

            this.setStatus(readResult.message, 'error');
            return;
        }

        const parsedRows = readResult.rows || [];
        this.previewRows = parsedRows;
        this.renderPreview(parsedRows);

        const productLoad = await window.ImportExport.loadActiveProducts();
        if (!this._isActive) return;

        if (!productLoad.ok) {
            this.validatedRows = [];
            this.productMap = new Map();

            if (fileInput) {
                fileInput.value = '';
            }

            this.setStatus(productLoad.message, 'error');
            return;
        }

        this.productMap = productLoad.productMap;

        const validation = window.ImportExport.validateRowsAgainstProducts(parsedRows, this.productMap);

        if (!validation.ok) {
            this.validatedRows = [];
            const lines = validation.missing
                .map(name => `- ${window.ImportExport.escapeHtml(name)}`)
                .join('<br>');

            if (fileInput) {
                fileInput.value = '';
            }

            this.setHtmlStatus(`
                <div><strong>Sistemde bulunamayan ürünler var.</strong></div>
                <div style="margin-top:8px;">${lines}</div>
                <div style="margin-top:8px;">Önce bu ürünleri Ürünler ekranından ekleyin.</div>
            `, 'error');
            return;
        }

        this.validatedRows = parsedRows;
        this.setStatus(`${parsedRows.length} satır okundu. Ürün kontrolü başarılı. Aktarmaya hazır.`, 'success');
    },

    async importToDatabase() {
        if (this._submitting) return;
        this._submitting = true;

        const btn = document.getElementById('importSalesBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Aktarılıyor...';
            btn.style.opacity = '0.7';
            btn.style.cursor = 'not-allowed';
        }

        try {
            if (!this.validatedRows.length) {
                this.setStatus('Aktarım için önce geçerli ve doğrulanmış dosya yüklemelisin.', 'error');
                return;
            }

            this._importKey = this._importKey || crypto.randomUUID();

            const result = await window.ImportExport.importSalesRows(
                this.validatedRows,
                this.productMap,
                this._importKey
            );
            if (!this._isActive) return;

            if (!result.ok) {
                const fileInput = document.getElementById('salesFileInput');
                if (fileInput) {
                    fileInput.value = '';
                }

                this.validatedRows = [];
                this.productMap = new Map();
                this._importKey = null;

                if (this._previewResetTimer) {
                    clearTimeout(this._previewResetTimer);
                    this._previewResetTimer = null;
                }

                this._previewResetTimer = setTimeout(() => {
                    this.resetPreview();
                    this._previewResetTimer = null;
                }, 10000);

                this.setStatus(result.message, 'error');
                return;
            }

            this.setStatus(`${result.importedCount} satır başarıyla aktarıldı.`, 'success');

            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:');
                window.ViewCache.invalidate('dashboard:');
            }

            window.dispatchEvent(new Event('sales:updated'));

            this.previewRows = [];
            this.validatedRows = [];
            this.productMap = new Map();
            this._importKey = null;

            const fileInput = document.getElementById('salesFileInput');
            if (fileInput) {
                fileInput.value = '';
            }

            this.renderPreview([]);
        } finally {
            this._submitting = false;

            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Satışa Aktar';
                btn.style.opacity = '1';
                btn.style.cursor = 'pointer';
            }
        }
    },

    renderPreview(rows) {
        const body = document.getElementById('transferPreviewBody');
        if (!body) return;

        if (!rows.length) {
            body.innerHTML = `
                <tr>
                    <td colspan="4" style="padding:18px 16px;color:#94a3b8;font-size:14px;">
                        Geçerli veri bulunamadı.
                    </td>
                </tr>
            `;
            return;
        }

        body.innerHTML = rows.map(row => `
            <tr>
                <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;color:#0f172a;">${window.ImportExport.escapeHtml(row.tarih)}</td>
                <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;color:#0f172a;">${window.ImportExport.escapeHtml(row.urun)}</td>
                <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;color:#0f172a;">${window.ImportExport.escapeHtml(row.adet)}</td>
                <td style="padding:14px 16px;border-bottom:1px solid #f1f5f9;color:#0f172a;">${window.ImportExport.escapeHtml(row.tutar)}</td>
            </tr>
        `).join('');
    },

    resetPreview() {
        this.previewRows = [];
        this.validatedRows = [];
        this.productMap = new Map();
        this._importKey = null;

        const fileInput = document.getElementById('salesFileInput');
        if (fileInput) {
            fileInput.value = '';
        }

        this.renderPreview([]);
    },

    setStatus(message, type) {
        const el = document.getElementById('transferStatus');
        if (!el) return;

        if (this._statusTimer) {
            clearTimeout(this._statusTimer);
            this._statusTimer = null;
        }

        if (!message) {
            el.innerHTML = '';
            return;
        }

        if (type === 'success') {
            el.innerHTML = `
                <div style="
                    padding:14px 16px;
                    border-radius:14px;
                    background:#ecfdf5;
                    border:1px solid #86efac;
                    color:#166534;
                    font-size:14px;
                    font-weight:600;
                ">
                    ${window.ImportExport.escapeHtml(message)}
                </div>
            `;

            this._statusTimer = setTimeout(() => {
                const statusEl = document.getElementById('transferStatus');
                if (statusEl) statusEl.innerHTML = '';
                this._statusTimer = null;
            }, 10000);
            return;
        }

        el.innerHTML = `
            <div style="
                padding:14px 16px;
                border-radius:14px;
                background:#fef2f2;
                border:1px solid #fca5a5;
                color:#991b1b;
                font-size:14px;
                font-weight:600;
            ">
                ${window.ImportExport.escapeHtml(message)}
            </div>
        `;

        this._statusTimer = setTimeout(() => {
            const statusEl = document.getElementById('transferStatus');
            if (statusEl) statusEl.innerHTML = '';
            this._statusTimer = null;
        }, 10000);
    },

    setHtmlStatus(html, type) {
        const el = document.getElementById('transferStatus');
        if (!el) return;

        if (this._statusTimer) {
            clearTimeout(this._statusTimer);
            this._statusTimer = null;
        }

        if (!html) {
            el.innerHTML = '';
            return;
        }

        if (type === 'success') {
            el.innerHTML = `
                <div style="
                    padding:14px 16px;
                    border-radius:14px;
                    background:#ecfdf5;
                    border:1px solid #86efac;
                    color:#166534;
                    font-size:14px;
                    font-weight:600;
                ">
                    ${html}
                </div>
            `;

            this._statusTimer = setTimeout(() => {
                const statusEl = document.getElementById('transferStatus');
                if (statusEl) statusEl.innerHTML = '';
                this._statusTimer = null;
            }, 10000);
            return;
        }

        el.innerHTML = `
            <div style="
                padding:14px 16px;
                border-radius:14px;
                background:#fef2f2;
                border:1px solid #fca5a5;
                color:#991b1b;
                font-size:14px;
                font-weight:600;
            ">
                ${html}
            </div>
        `;

        this._statusTimer = setTimeout(() => {
            const statusEl = document.getElementById('transferStatus');
            if (statusEl) statusEl.innerHTML = '';
            this._statusTimer = null;
        }, 10000);
    },

    async downloadBackup() {
        const result = await window.SalesService.getFullBackup();
        if (!this._isActive) return;

        if (!result.ok) {
            this.setStatus(result.message, 'error');
            return;
        }

        const blob = new Blob(
            [JSON.stringify(result.data, null, 2)],
            { type: 'application/json' }
        );

        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = 'backup.json';
        a.click();

        URL.revokeObjectURL(url);

        this.setStatus('Backup indirildi.', 'success');
    },

    async handleBackupFile(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        this._backupData = null;

        try {
            const text = await file.text();
            if (!this._isActive) return;
            const parsed = JSON.parse(text);

            if (!parsed || !Array.isArray(parsed.sales)) {
                this.setRestoreStatus('Geçersiz backup dosyası. sales alanı bulunamadı.', 'error');
                return;
            }

            this._backupData = parsed;
            this.setRestoreStatus(`Backup yüklendi. ${parsed.sales.length} satış kaydı bulundu. "Geri Yükle" butonuna bas.`, 'success');
        } catch (err) {
            this._backupData = null;
            this.setRestoreStatus('JSON dosyası okunamadı veya bozuk.', 'error');
        }
    },

    async restoreFromBackup() {
        if (this._restoring) return;

        if (!this._backupData) {
            this.setRestoreStatus('Önce bir backup JSON dosyası seçmelisin.', 'error');
            return;
        }

        this._restoring = true;

        const btn = document.getElementById('restoreBackupBtn');
        const setBtnLoading = (loading) => {
            if (!btn) return;
            btn.disabled = loading;
            btn.textContent = loading ? 'Yükleniyor...' : 'Geri Yükle';
            btn.style.opacity = loading ? '0.7' : '1';
            btn.style.cursor = loading ? 'not-allowed' : 'pointer';
        };

        setBtnLoading(true);
        this.setRestoreStatus('Geri yükleme işlemi başladı, lütfen bekleyin...', 'success');

        let success = false;
        try {
            const result = await window.SalesService.restoreFromBackup(this._backupData);
            if (!this._isActive) return;

            if (!result.ok) {
                this.setRestoreStatus(result.message, 'error');
                setBtnLoading(false);
                this._restoring = false;
                return;
            }

            success = true;
            this._backupData = null;

            const backupFileInput = document.getElementById('backupFileInput');
            if (backupFileInput) {
                backupFileInput.value = '';
            }

            this.setRestoreStatus(result.message, 'success');

            await new Promise(resolve => setTimeout(resolve, 1500));
            if (!this._isActive) return;

            if (window.ViewCache) {
                window.ViewCache.invalidate('sales:');
                window.ViewCache.invalidate('dashboard:');
            }
            window.dispatchEvent(new Event('dashboard:refresh'));
        } catch (err) {
            this.setRestoreStatus(err.message || 'Geri yükleme başarısız', 'error');
        } finally {
            setBtnLoading(false);
            this._restoring = false;
        }
    },

    setRestoreStatus(message, type) {
        const el = document.getElementById('restoreStatus');
        if (!el) return;

        if (this._restoreStatusTimer) {
            clearTimeout(this._restoreStatusTimer);
            this._restoreStatusTimer = null;
        }

        if (!message) {
            el.innerHTML = '';
            return;
        }

        if (type === 'success') {
            el.innerHTML = `
                <div style="
                    padding:14px 16px;
                    border-radius:14px;
                    background:#ecfdf5;
                    border:1px solid #86efac;
                    color:#166534;
                    font-size:14px;
                    font-weight:600;
                ">
                    ${window.ImportExport.escapeHtml(message)}
                </div>
            `;

            this._restoreStatusTimer = setTimeout(() => {
                const statusEl = document.getElementById('restoreStatus');
                if (statusEl) statusEl.innerHTML = '';
                this._restoreStatusTimer = null;
            }, 10000);
            return;
        }

        el.innerHTML = `
            <div style="
                padding:14px 16px;
                border-radius:14px;
                background:#fef2f2;
                border:1px solid #fca5a5;
                color:#991b1b;
                font-size:14px;
                font-weight:600;
            ">
                ${window.ImportExport.escapeHtml(message)}
            </div>
        `;

        this._restoreStatusTimer = setTimeout(() => {
            const statusEl = document.getElementById('restoreStatus');
            if (statusEl) statusEl.innerHTML = '';
            this._restoreStatusTimer = null;
        }, 10000);
    }
};