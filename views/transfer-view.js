/* ============================================================
   views/transfer-view.js
   Aktarma ekrani
   View sadece render + event + sonuc gosterimi yapar
   ============================================================ */

window.TransferView = {
    previewRows: [],
    validatedRows: [],
    productMap: new Map(),

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
            </section>
        `;

        this.previewRows = [];
        this.validatedRows = [];
        this.productMap = new Map();

        this.bindEvents();
    },

    bindEvents() {
        const downloadBtn = document.getElementById('downloadSalesTemplateBtn');
        const fileInput = document.getElementById('salesFileInput');
        const importBtn = document.getElementById('importSalesBtn');

        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => this.downloadTemplate());
        }

        if (fileInput) {
            fileInput.addEventListener('change', (event) => this.handleExcelFile(event));
        }

        if (importBtn) {
            importBtn.addEventListener('click', () => this.importToDatabase());
        }
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
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const readResult = await window.ImportExport.readSalesExcel(file);

        if (!readResult.ok) {
            if (readResult.rows && readResult.rows.length) {
                this.previewRows = readResult.rows;
                this.validatedRows = [];
                this.renderPreview(readResult.rows);
            } else {
                this.resetPreview();
            }

            this.setStatus(readResult.message, 'error');
            return;
        }

        const parsedRows = readResult.rows || [];
        this.previewRows = parsedRows;
        this.renderPreview(parsedRows);

        const productLoad = await window.ImportExport.loadActiveProducts();

        if (!productLoad.ok) {
            this.validatedRows = [];
            this.productMap = new Map();
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
        if (!this.validatedRows.length) {
            this.setStatus('Aktarım için önce geçerli ve doğrulanmış dosya yüklemelisin.', 'error');
            return;
        }

        const result = await window.ImportExport.importSalesRows(this.validatedRows, this.productMap);

        if (!result.ok) {
            this.setStatus(result.message, 'error');
            return;
        }

        this.setStatus(`${result.importedCount} satır başarıyla aktarıldı.`, 'success');
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
        this.renderPreview([]);
    },

    setStatus(message, type) {
        const el = document.getElementById('transferStatus');
        if (!el) return;

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
    },

    setHtmlStatus(html, type) {
        const el = document.getElementById('transferStatus');
        if (!el) return;

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
    }
};