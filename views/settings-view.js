/* ============================================================
   SETTINGS VIEW — Faz 7 Placeholder + Backup + Veri Aktarma
   NOTE: "Veri Aktarma" section reuses window.TransferView
   render + event handlers verbatim. Duplicate backup UI from
   TransferView (Backup İndir / JSON Seç / Geri Yükle) is stripped
   post-render because the "Yedekleme" section above already
   covers it. Underlying TransferView logic is NOT modified.
   ============================================================ */

window.SettingsView = {
    render(container) {
        container.innerHTML = `
            <div class="coming-soon">
                <div class="coming-soon-icon">⚙️</div>
                <h2>Ayarlar</h2>
                <p>İşletme bilgileri, kullanıcı yönetimi, yetki rolleri, PIN ayarları ve plan yükseltme.</p>
                <span class="phase-badge">Faz 7 — Yakında</span>
            </div>

            <div class="settings-section" style="margin-top:24px;padding:20px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;">
                <h3 style="margin:0 0 8px 0;font-size:16px;">Yedekleme</h3>
                <p style="margin:0 0 16px 0;color:#6b7280;font-size:13px;">
                    Tüm verilerinizi JSON olarak indirin veya önceki bir yedeği geri yükleyin.
                </p>
                <div style="display:flex;gap:12px;flex-wrap:wrap;">
                    <button id="btnBackupExport" class="btn btn-primary" type="button">Yedeği İndir</button>
                    <button id="btnBackupImport" class="btn btn-secondary" type="button">Yedekten Geri Yükle</button>
                </div>
            </div>

            <div class="settings-section" style="margin-top:24px;">
                <h3 style="margin:0 0 12px 0;font-size:16px;">Veri Aktarma</h3>
                <div id="settingsTransferMount"></div>
            </div>
        `;

        this.bindBackupEvents();
        this.mountTransfer();
    },

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

                importBtn.disabled = true;
                try {
                    const r = await window.ImportExport.importAll(file);
                    if (!r.ok) {
                        if (window.Toast) Toast.error(r.error || 'Import failed');
                    } else {
                        // Detayli inserted/skipped ozet
                        const ins = r.inserted || {};
                        const skp = r.skipped  || {};
                        const insTotal = Number(r.insertedTotal || 0);
                        const skpTotal = Number(r.skippedTotal  || 0);

                        // Ana satir
                        let mainLine =
                            (ins.sales || 0)         + ' satış eklendi';
                        if (skpTotal > 0) {
                            mainLine += ' | ' + skpTotal + ' kayıt zaten mevcuttu, atlandı';
                        }

                        // Detay satiri (kategori bazinda kirilim)
                        const parts = [];
                        if ((ins.products || 0)      || (skp.products || 0))      parts.push('Ürünler: ' + (ins.products||0)      + ' eklendi, ' + (skp.products||0)      + ' atlandı');
                        if ((ins.sales || 0)         || (skp.sales || 0))         parts.push('Satışlar: ' + (ins.sales||0)         + ' eklendi, ' + (skp.sales||0)         + ' atlandı');
                        if ((ins.product_sales || 0) || (skp.product_sales || 0)) parts.push('Ürün-Satış: ' + (ins.product_sales||0) + ' eklendi, ' + (skp.product_sales||0) + ' atlandı');
                        if ((ins.expenses || 0)      || (skp.expenses || 0))      parts.push('Giderler: ' + (ins.expenses||0)      + ' eklendi, ' + (skp.expenses||0)      + ' atlandı');

                        const fullMessage = parts.length
                            ? mainLine + '\n' + parts.join('\n')
                            : mainLine;

                        if (window.Toast) {
                            if (insTotal > 0) {
                                Toast.success(fullMessage);
                            } else if (skpTotal > 0) {
                                // Hicbir sey eklenmedi, hepsi duplicate
                                Toast.info ? Toast.info(fullMessage) : Toast.success(fullMessage);
                            } else {
                                Toast.success('Yedek geri yüklendi (boş)');
                            }
                        }

                        // Sayfa refresh — kullanici toast'u okuyabilsin
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
        const mount = document.getElementById('settingsTransferMount');
        if (!mount) return;
        if (!window.TransferView || typeof window.TransferView.render !== 'function') return;

        // Reuse TransferView 1:1 (render + IDs + listeners + lifecycle).
        window.TransferView.render(mount);

        // Strip the duplicate backup UI TransferView rendered — the
        // "Yedekleme" section above is the single source of truth.
        this._stripDuplicateBackupUI(mount);
    },

    _stripDuplicateBackupUI(mount) {
        // 1) "Backup İndir" button that sits in the import toolbar
        const dlBtn = mount.querySelector('#downloadBackupBtn');
        if (dlBtn && dlBtn.parentElement) {
            dlBtn.parentElement.removeChild(dlBtn);
        }

        // 2) Entire "Backup Geri Yükle" card (JSON file picker + Geri Yükle + restoreStatus)
        const restoreBtn = mount.querySelector('#restoreBackupBtn');
        if (restoreBtn) {
            let el = restoreBtn;
            // Walk up to the direct child of <section class="transfer-page">
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
    }
};
