/* ============================================================
   IMPORT VIEW — FAZ 2.1 / 073-C (+ 073-C2 table-based mapping)
   "Parse Onizleme + Mapping Onayi" modal'i.

   BU EKRAN MATCHING REVIEW DEGILDIR.
   Kapsam: dosya sec → ImportParsers.parseFile → meta/preview/mapping goster
           → kullanici mapping'i duzeltir → import_stage_batch RPC'sine gonder.

   YOK: urun eslestirme, yesil/sari/kirmizi, commit, rollback, purchase insert,
        cost update, supplier/alias, OCR, AI.

   Bagimlilik (mevcut, yeni client/hardcoded YOK):
     - window.ImportParsers        (073-B/B2 parser; table full-matrix)
     - window.SupabaseService      (getClient / getTenantId)
     - window.Toast                (bildirim)

   073-C2 — TABLE-BASED MAPPING:
     Mapping dropdown secenekleri parse.table.columns'tan gelir (TUM kolonlar,
     parser'in otomatik tanimadiklari DAHIL). RPC'ye giden p_lines, kullanici
     mapping'ine gore parse.table.rows uzerinden YENIDEN uretilir. Boylece
     "Mal Aciklamasi" gibi otomatik taninmayan kolon da secilebilir.
     table yoksa eski rawLines/column_mapping yoluna FALLBACK edilir.
   ============================================================ */

window.ImportView = (function () {
    'use strict';

    var MAPPABLE_FIELDS = [
        'raw_name', 'raw_product_code', 'raw_qty', 'raw_unit', 'raw_unit_price',
        'raw_vat', 'raw_vat_amount', 'raw_discount', 'raw_discount_1', 'raw_discount_2',
        'raw_discount_3', 'raw_discount_amount', 'raw_line_total'
    ];
    var RAW_FIELDS = MAPPABLE_FIELDS.concat([
        'source_line_basis', 'line_type', 'discount_rates', 'discount_calculation_method',
        'discount_parse_status', 'effective_discount_rate', 'line_discount_amount',
        'calculated_gross_amount', 'calculated_net_amount', 'calculation_input_gross_amount',
        'discount_review_required'
    ]);
    // 075-G: kullanici dili. "Birim fiyat" ve "Tutar" yaniltmasin diye
    // "Faturadaki ..." (bu ekran ham veriyi gosterir, KDV hesabi yapmaz).
    var FIELD_LABELS = {
        raw_name:       'Ürün',
        raw_product_code: 'Ürün Kodu',
        raw_qty:        'Miktar',
        raw_unit:       'Birim',
        raw_unit_price: 'Faturadaki Birim Fiyat',
        raw_vat:        'KDV Oranı',
        raw_vat_amount: 'Faturadaki KDV Tutarı',
        raw_discount:   'İskonto Oranı / Ham Oranlar',
        raw_discount_1: 'İskonto 1',
        raw_discount_2: 'İskonto 2',
        raw_discount_3: 'İskonto 3',
        raw_discount_amount: 'Faturadaki İskonto Tutarı',
        raw_line_total: 'Faturadaki Satır Tutarı',
        source_line_basis: 'Kaynak Tutar Anlamı',
        line_type:      'Satır Tipi'
    };
    var MAX_ROWS = 2000;
    var PREVIEW_ROW_LIMIT = 20;   // 075-H-A: onizleme satir tavani (parser ile ayni deger)
    var LS_PREFIX = 'checkup_import_mapping';
    var SAVE_LABEL = 'Eşleştirmeye Gönder';

    // 075-H-A: hesap kontrolu / durum renkleri (tek standart)
    var STATUS_COLORS = {
        ok:    { fg: '#166534', bg: '#dcfce7' },  // yesil — uyumlu/tam/hazir
        warn:  { fg: '#92400e', bg: '#fef3c7' },  // sari  — kontrol gerekli
        bad:   { fg: '#991b1b', bg: '#fee2e2' },  // kirmizi — hata/eksik
        muted: { fg: '#475569', bg: '#f1f5f9' }   // gri   — veri yok / notr
    };
    // satir hesap-kodu → renk tonu
    var MATH_TONE = {
        net_match: 'ok', discount_match: 'ok',
        gross_match: 'warn', invalid_number: 'warn', not_enough_data: 'muted',
        mismatch: 'bad'
    };
    // hesap kontrolu yapilacak kritik alanlar
    var CRITICAL_FIELDS = ['raw_name', 'raw_qty', 'raw_unit_price', 'raw_line_total'];

    // ---- in-memory state (modal acikken) ----
    // { file, parse, useTable, sourceColumns, columnSeries, userMapping, tenantKey }
    var st = null;
    var _submitting = false;   // 075-G cift-gonderim guard

    // ============================================================
    // Yardimcilar
    // ============================================================
    function escapeHtml(v) {
        if (v == null) return '';
        return String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function toastErr(msg)  { if (window.Toast) window.Toast.error(msg);  else alert(msg); }
    function toastOk(msg)   { if (window.Toast) window.Toast.success(msg); }
    function toastInfo(msg) { if (window.Toast) window.Toast.info(msg); }
    function el(id) { return document.getElementById(id); }

    // ============================================================
    // STYLE (scoped) — index.html/css'e dokunmadan tek sefer enjekte
    // ============================================================
    function injectStyles() {
        if (el('iv-styles')) return;
        var s = document.createElement('style');
        s.id = 'iv-styles';
        s.textContent = [
            '.iv-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;',
            'display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;overflow:auto;}',
            '.iv-modal{background:#fff;border-radius:14px;width:100%;max-width:820px;box-shadow:0 20px 60px rgba(0,0,0,.25);',
            'font-family:inherit;color:#0f172a;overflow:hidden;}',
            '.iv-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #e2e8f0;}',
            '.iv-head h3{margin:0;font-size:17px;font-weight:800;}',
            '.iv-head .iv-sub{font-size:12px;color:#64748b;margin-top:2px;}',
            '.iv-x{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#64748b;}',
            '.iv-body{padding:20px 22px;}',
            '.iv-drop{border:2px dashed #cbd5e1;border-radius:12px;padding:26px;text-align:center;cursor:pointer;background:#f8fafc;}',
            '.iv-drop.iv-drag{border-color:#3b82f6;background:#eff6ff;}',
            '.iv-drop strong{display:block;font-size:14px;margin-bottom:4px;}',
            '.iv-drop span{font-size:12px;color:#64748b;}',
            '.iv-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin:16px 0;font-size:12px;}',
            '.iv-meta div b{color:#475569;font-weight:700;}',
            '.iv-warns{margin:10px 0;}',
            '.iv-warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:7px 10px;font-size:12px;margin-bottom:6px;}',
            '.iv-map{display:grid;grid-template-columns:repeat(2,1fr);gap:10px 18px;margin:14px 0;}',
            '.iv-map label{display:block;font-size:11px;font-weight:700;color:#475569;margin-bottom:3px;}',
            '.iv-map .iv-req{color:#dc2626;}',
            '.iv-map select{width:100%;padding:7px 8px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;background:#fff;}',
            '.iv-tablewrap{max-height:240px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px;margin-top:8px;}',
            '.iv-table{border-collapse:collapse;width:100%;font-size:12px;}',
            '.iv-table th{position:sticky;top:0;background:#f1f5f9;text-align:left;padding:6px 8px;font-weight:700;white-space:nowrap;}',
            '.iv-table td{padding:5px 8px;border-top:1px solid #f1f5f9;white-space:nowrap;}',
            '.iv-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;',
            'padding:16px 22px;border-top:1px solid #e2e8f0;background:#f8fafc;}',
            '.iv-count{font-size:12px;color:#64748b;}',
            '.iv-btns{display:flex;gap:10px;}',
            '.iv-btn{border:0;border-radius:9px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;}',
            '.iv-btn-sec{background:#e2e8f0;color:#334155;}',
            '.iv-btn-pri{background:#2563eb;color:#fff;}',
            '.iv-btn-pri:disabled{background:#94a3b8;cursor:not-allowed;}',
            '.iv-hidden{display:none!important;}',
            '.iv-tech{margin:4px 0 6px;}',
            '.iv-tech summary{cursor:pointer;color:#64748b;font-weight:700;font-size:12px;list-style:revert;}',
            '.iv-spin{font-size:13px;color:#475569;padding:20px;text-align:center;}',
            // 075-H-A: dosya sec butonu + durust destek metni
            '.iv-pickbtn{margin:12px auto 0;display:inline-block;border:0;border-radius:9px;',
            'background:#2563eb;color:#fff;padding:9px 20px;font-size:13px;font-weight:700;cursor:pointer;}',
            '.iv-pickbtn:hover{background:#1d4ed8;}',
            '.iv-support{font-size:11px;color:#94a3b8;margin-top:10px;line-height:1.4;}',
            // 075-H-A: kontrol kartlari
            '.iv-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0;}',
            '.iv-card{border:1px solid #e2e8f0;border-radius:12px;padding:11px 13px;background:#fff;}',
            '.iv-card .n{font-size:18px;font-weight:800;line-height:1.1;}',
            '.iv-card .t{font-size:10px;font-weight:700;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.03em;}',
            // 075-H-A: satir kontrol-durumu rozeti
            '.iv-st{display:inline-block;font-size:11px;font-weight:800;padding:3px 8px;border-radius:6px;white-space:nowrap;}'
        ].join('');
        document.head.appendChild(s);
    }

    // ============================================================
    // MODAL ISKELET
    // ============================================================
    function buildModal() {
        var overlay = document.createElement('div');
        overlay.className = 'iv-overlay';
        overlay.id = 'iv-overlay';
        overlay.innerHTML =
            '<div class="iv-modal" role="dialog" aria-modal="true">' +
              '<div class="iv-head">' +
                '<div><h3>📄 Fatura Yükle</h3>' +
                '<div class="iv-sub">Faturadaki kolonları kontrol edin. Sonraki adımda ürünler hammaddelerle eşleştirilecek.</div></div>' +
                '<button class="iv-x" id="iv-close" type="button" aria-label="Kapat">&times;</button>' +
              '</div>' +
              '<div class="iv-body" id="iv-body">' +
                '<div class="iv-drop" id="iv-drop">' +
                  '<strong>Fatura dosyasını yükleyin</strong>' +
                  '<span>Dosyayı buraya sürükleyip bırakın</span>' +
                  '<button type="button" class="iv-pickbtn" id="iv-pick">Dosya Seç</button>' +
                  '<div class="iv-support">Şu an CSV ve XLSX desteklenir. ' +
                    'PDF ve e-Fatura/XML desteği sonraki aşamada eklenecek.</div>' +
                  '<input type="file" id="iv-file" accept=".csv,.xlsx,.xls,.txt" class="iv-hidden">' +
                '</div>' +
                '<div id="iv-result" class="iv-hidden"></div>' +
              '</div>' +
              '<div class="iv-foot">' +
                '<div class="iv-count" id="iv-count"></div>' +
                '<div class="iv-btns">' +
                  '<button class="iv-btn iv-btn-sec" id="iv-cancel" type="button">İptal</button>' +
                  '<button class="iv-btn iv-btn-pri" id="iv-save" type="button" disabled>Eşleştirmeye Gönder</button>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        // 075-E / Fix 4: modal YALNIZCA X ve İptal ile kapanir.
        // Dis-overlay tiklama + Esc ile kapanma KALDIRILDI (kaza ile kapanma onlenir).
        el('iv-close').addEventListener('click', close);
        el('iv-cancel').addEventListener('click', close);

        var drop = el('iv-drop');
        var fileInput = el('iv-file');
        drop.addEventListener('click', function () { fileInput.click(); });
        // "Dosya Seç" butonu: drop'a da tikliyor; cift-acilmayi onlemek icin
        // event'i durdurup file input'u dogrudan tetikler.
        var pickBtn = el('iv-pick');
        if (pickBtn) pickBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            fileInput.click();
        });
        fileInput.addEventListener('change', function () {
            if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
        });
        drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('iv-drag'); });
        drop.addEventListener('dragleave', function () { drop.classList.remove('iv-drag'); });
        drop.addEventListener('drop', function (e) {
            e.preventDefault(); drop.classList.remove('iv-drag');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
        });

        el('iv-save').addEventListener('click', onSave);
    }

    function close() {
        var o = el('iv-overlay');
        if (o && o.parentNode) o.parentNode.removeChild(o);
        st = null;
    }

    // ============================================================
    // DOSYA SEC → PARSE
    // ============================================================
    async function handleFile(file) {
        if (!window.ImportParsers || typeof window.ImportParsers.parseFile !== 'function') {
            toastErr('Parser bileşeni (ImportParsers) yüklenemedi. Sayfayı yenileyip tekrar deneyin.');
            return;
        }

        var name = (file.name || '').toLowerCase();
        if (!/\.(csv|xlsx|xls|txt)$/.test(name)) {
            toastErr('Desteklenmeyen dosya tipi. Yalnızca CSV veya XLSX yükleyebilirsiniz.');
            return;
        }

        var body = el('iv-result');
        body.classList.remove('iv-hidden');
        body.innerHTML = '<div class="iv-spin">Dosya okunuyor…</div>';
        setSave(false, '');

        var parse;
        try {
            parse = await window.ImportParsers.parseFile(file);
        } catch (e) {
            body.innerHTML = '';
            body.classList.add('iv-hidden');
            toastErr('Dosya okunamadı: ' + (e && e.message ? e.message : 'bilinmeyen hata'));
            return;
        }

        if (!parse || !parse.batchMeta) {
            body.classList.add('iv-hidden');
            toastErr('Dosya çözümlenemedi.');
            return;
        }

        var tenantKey = 'default';
        try {
            if (window.SupabaseService && window.SupabaseService.getTenantId) {
                var t = await window.SupabaseService.getTenantId();
                if (t) tenantKey = String(t);
            }
        } catch (e2) { /* tenant alinamazsa default */ }

        initState(file, parse, tenantKey);
        renderResult();
    }

    // ============================================================
    // STATE — 073-C2: oncelik TABLE (tum kolonlar); yoksa rawLines FALLBACK
    // ============================================================
    function initState(file, parse, tenantKey) {
        var useTable = !!(parse.table &&
            Array.isArray(parse.table.columns) && parse.table.columns.length &&
            Array.isArray(parse.table.rows));

        var sourceColumns = [];
        var columnSeries = {};   // colIndex → [satir degerleri]

        if (useTable) {
            // TUM kolonlar secenek olur (parser'in tanimadiklari DAHIL)
            sourceColumns = parse.table.columns.map(function (c) {
                return {
                    colIndex: c.index,
                    header: (c.label != null && String(c.label).trim() !== '')
                        ? String(c.label) : ('Kolon ' + (c.index + 1))
                };
            });
            parse.table.columns.forEach(function (c) {
                var key = 'col_' + c.index;
                columnSeries[c.index] = parse.table.rows.map(function (r) {
                    return (r && r[key] != null) ? r[key] : null;
                });
            });
        } else {
            // FALLBACK (geriye uyum): yalniz parser-tespitli kolonlar
            var mapping = parse.batchMeta.column_mapping || {};
            var columns = (parse.preview && parse.preview.columns) || [];
            Object.keys(mapping).forEach(function (origField) {
                var ci = mapping[origField];
                if (ci == null) return;
                columnSeries[ci] = parse.rawLines.map(function (l) { return l[origField]; });
                sourceColumns.push({
                    colIndex: ci,
                    header: (columns[ci] != null && String(columns[ci]).trim() !== '')
                        ? String(columns[ci]) : ('Kolon ' + (ci + 1))
                });
            });
            sourceColumns.sort(function (a, b) { return a.colIndex - b.colIndex; });
        }

        // default userMapping = parser otomatik tespiti (gecerli colIndex ise)
        var mapping0 = parse.batchMeta.column_mapping || {};
        var userMapping = {};
        MAPPABLE_FIELDS.forEach(function (f) {
            userMapping[f] = (mapping0[f] != null && columnSeries[mapping0[f]] != null) ? mapping0[f] : null;
        });

        st = {
            file: file, parse: parse, useTable: useTable,
            sourceColumns: sourceColumns, columnSeries: columnSeries,
            userMapping: userMapping, tenantKey: tenantKey
        };

        applyStoredMapping();
    }

    // toplam veri satiri (kaynak universe)
    function dataRowCount() {
        return st.useTable ? st.parse.table.rows.length : st.parse.rawLines.length;
    }

    // Table-based mapping tum kaynak satirlari yeniden kurar. Staging'e yalniz
    // gercek urun adayi gitsin; metadata/footer etiketleri exact eslesmeyle elenir.
    function isMappedProductLineCandidate(line) {
        if (!line || line.raw_name == null || String(line.raw_name).trim() === '') return false;

        var normalizedName = (window.ImportParsers && ImportParsers.normalizeHeader)
            ? ImportParsers.normalizeHeader(line.raw_name)
            : String(line.raw_name).toLowerCase().trim();
        var excludedLabels = {
            'ara toplam': true,
            'satir iskonto': true,
            'genel iskonto': true,
            'net toplam': true,
            'dagitilmis net toplam': true,
            'kdv toplami': true,
            'genel toplam': true,
            'fatura no': true,
            'tedarikci': true,
            'belge no': true,
            'fatura tarihi': true,
            'irsaliye tarihi': true,
            'son odeme tarihi': true,
            'dosya turu': true,
            'kontrol': true,
            'deger': true
        };
        if (excludedLabels[normalizedName] === true) return false;

        var qty = _np(line.raw_qty);
        if (qty == null || qty <= 0) return false;

        var unitPrice = _np(line.raw_unit_price);
        var lineTotal = _np(line.raw_line_total);
        return unitPrice != null || lineTotal != null;
    }

    function sameMappedSourceLine(a, b) {
        if (!a || !b) return false;
        return MAPPABLE_FIELDS.every(function (f) {
            var av = a[f] == null ? null : String(a[f]);
            var bv = b[f] == null ? null : String(b[f]);
            return av === bv;
        });
    }

    function applyLineSemantics(line, rowIndex) {
        if (window.ImportParsers && ImportParsers.applyDiscountSemantics) {
            return ImportParsers.applyDiscountSemantics(line);
        }

        var parserLine = st.parse && st.parse.rawLines ? st.parse.rawLines[rowIndex] : null;
        var sameSource = sameMappedSourceLine(line, parserLine);
        var allowedBasis = { gross: true, net: true, same: true, unknown: true };
        var allowedTypes = {
            normal: true, promotion: true, deposit_sale: true,
            deposit_return: true, other: true, unknown: true
        };

        var basis = sameSource && allowedBasis[parserLine.source_line_basis]
            ? parserLine.source_line_basis : null;
        var lineType = sameSource && allowedTypes[parserLine.line_type]
            ? parserLine.line_type : null;

        if (!basis && window.ImportParsers && ImportParsers.analyzeSourceLineBasis) {
            basis = ImportParsers.analyzeSourceLineBasis(line);
        }
        if (!lineType && window.ImportParsers && ImportParsers.classifyLineType) {
            lineType = ImportParsers.classifyLineType(line);
        }

        line.source_line_basis = allowedBasis[basis] ? basis : 'unknown';
        line.line_type = allowedTypes[lineType] ? lineType : 'unknown';
        return line;
    }

    // ============================================================
    // buildRawLinesFromTable — kullanici mapping'i ile p_lines uret
    //   field → colIndex → columnSeries[colIndex][i]. Tum-alanlari-bos satir atlanir.
    // ============================================================
    function buildRawLinesFromTable() {
        var n = dataRowCount();
        var lines = [];
        for (var i = 0; i < n; i++) {
            var line = {};
            var allNull = true;
            for (var k = 0; k < MAPPABLE_FIELDS.length; k++) {
                var f = MAPPABLE_FIELDS[k];
                var ci = st.userMapping[f];
                var v = (ci != null && st.columnSeries[ci]) ? st.columnSeries[ci][i] : null;
                if (v == null || String(v).trim() === '') { line[f] = null; }
                else { line[f] = String(v); allNull = false; }
            }
            if (allNull) continue;
            if (!isMappedProductLineCandidate(line)) continue;
            applyLineSemantics(line, i);
            RAW_FIELDS.forEach(function (f) {
                if (line[f] === undefined) line[f] = null;
            });
            lines.push(line);
        }
        return lines;
    }

    // ============================================================
    // localStorage mapping hafizasi (kalici tablo YOK)
    // ============================================================
    function headerSignature() {
        // table varsa table kolon label'lari; yoksa preview basliklari
        var cols = st.useTable
            ? st.sourceColumns.map(function (c) { return c.header; })
            : ((st.parse.preview && st.parse.preview.columns) || []);
        return cols.map(function (c) { return (c == null ? '' : String(c)).toLowerCase().trim(); }).join('|');
    }
    function lsKey() {
        return LS_PREFIX + ':' + st.tenantKey + ':' + st.parse.batchMeta.source_type + ':' + headerSignature();
    }
    function applyStoredMapping() {
        try {
            var raw = window.localStorage.getItem(lsKey());
            if (!raw) return;
            var saved = JSON.parse(raw); // { targetField: colIndex }
            MAPPABLE_FIELDS.forEach(function (f) {
                if (saved[f] != null && st.columnSeries[saved[f]] != null) {
                    st.userMapping[f] = saved[f];
                }
            });
        } catch (e) { /* hafiza bozuksa yok say */ }
    }
    function persistMapping() {
        try { window.localStorage.setItem(lsKey(), JSON.stringify(st.userMapping)); }
        catch (e) { /* quota → sessiz */ }
    }

    // ============================================================
    // RENDER
    // ============================================================
    function renderResult() {
        var m = st.parse.batchMeta;
        var p = st.parse.preview || { columns: [], rows: [], warnings: [] };
        var rowCount = dataRowCount();

        // 075-G/2: varsayilan gorunum sade (Dosya + Satır). Teknik bilgiler
        // (Tür/Sayfa/Ayraç/Kodlama) "Teknik detay" acilir alaninda.
        var metaHtml =
            '<div class="iv-meta">' +
              metaCell('Dosya', m.original_filename) +
              metaCell('Satır', String(rowCount)) +
            '</div>' +
            '<details class="iv-tech"><summary>Teknik detay</summary>' +
              '<div class="iv-meta" style="margin-top:8px;">' +
                metaCell('Tür', m.source_type) +
                metaCell('Sayfa', m.sheet_name) +
                metaCell('Ayraç', m.delimiter) +
                metaCell('Kodlama', m.encoding) +
              '</div>' +
            '</details>';

        var warnHtml = '';
        if (p.warnings && p.warnings.length) {
            warnHtml = '<div class="iv-warns">' + p.warnings.map(function (w) {
                return '<div class="iv-warn">⚠ ' + escapeHtml(w) + '</div>';
            }).join('') + '</div>';
        }

        // mapping dropdownlari — secenekler st.sourceColumns (TABLE: tum kolonlar)
        var mapHtml = '<div class="iv-map">' + MAPPABLE_FIELDS.map(function (f) {
            var sel = st.userMapping[f];
            var optsSel = ['<option value="">(yok)</option>'].concat(st.sourceColumns.map(function (sc) {
                var s = (String(sc.colIndex) === String(sel)) ? ' selected' : '';
                return '<option value="' + sc.colIndex + '"' + s + '>' + escapeHtml(sc.header) + '</option>';
            })).join('');
            var req = (f === 'raw_name') ? ' <span class="iv-req">*</span>' : '';
            return '<div><label>' + FIELD_LABELS[f] + req + '</label>' +
                   '<select data-field="' + f + '" class="iv-msel">' + optsSel + '</select></div>';
        }).join('') + '</div>';

        el('iv-result').innerHTML =
            metaHtml + warnHtml +
            '<div style="font-size:13px;font-weight:800;margin:6px 0 2px;color:#0f172a;">Fatura Kolonlarını Doğrula</div>' +
            '<div style="font-size:12px;color:#64748b;margin-bottom:8px;">Sistem, faturadaki sütunları otomatik tanır. Yanlış eşleşme varsa doğru kolonu seçin.</div>' +
            mapHtml +
            '<div id="iv-colwarn"></div>' +
            '<div id="iv-cards"></div>' +
            '<div style="font-size:13px;font-weight:800;margin:10px 0 2px;color:#0f172a;">Önizleme (ilk satırlar)</div>' +
            '<div style="font-size:12px;color:#64748b;margin-bottom:6px;">Eşlemeye göre gösterilir; bu ekran faturadaki ham veriyi gösterir, KDV hesaplaması yapılmaz.</div>' +
            '<div id="iv-preview"></div>';

        var sels = document.querySelectorAll('.iv-msel');
        for (var i = 0; i < sels.length; i++) {
            sels[i].addEventListener('change', function () {
                var f = this.getAttribute('data-field');
                var v = this.value === '' ? null : parseInt(this.value, 10);
                st.userMapping[f] = v;
                persistMapping();
                renderDynamic();      // 075-H-A: mapping degisince kart+uyari+onizleme
                refreshSaveState();
            });
        }

        renderDynamic();
        refreshSaveState();
    }

    // ============================================================
    // 075-H-A: mapping'e bagli dinamik bolumler (kolon uyarilari + kartlar +
    //   onizleme). Her mapping degisikliginde topluca yeniden cizilir.
    // ============================================================
    function renderDynamic() {
        renderColWarnings();
        renderCards();
        renderPreview();
    }

    // satir indeksinden kullanici mapping'ine gore ham satir nesnesi uret
    function lineAt(i) {
        var line = {};
        for (var k = 0; k < MAPPABLE_FIELDS.length; k++) {
            var f = MAPPABLE_FIELDS[k];
            var ci = st.userMapping[f];
            var v = (ci != null && st.columnSeries[ci]) ? st.columnSeries[ci][i] : null;
            line[f] = (v == null || String(v).trim() === '') ? null : String(v);
        }
        return applyLineSemantics(line, i);
    }

    // ============================================================
    // 075-H-A: KOLON DOGRULUK KONTROLLERI (uyari seviyeli — bloklamaz)
    //   - ayni kaynak kolon birden cok kritik alana atanmis
    //   - miktar/birim fiyat/satir tutari kolonu sayisal gorunmuyor
    //   - KDV kolonu anormal (negatif / >100)
    // ============================================================
    function _np(v) {
        if (window.ImportParsers && ImportParsers.normalizeImportNumber) {
            var s = ImportParsers.normalizeImportNumber(v);
            if (s == null) return null;
            var n = parseFloat(s);
            return isFinite(n) ? n : null;
        }
        var n2 = parseFloat(v);
        return isFinite(n2) ? n2 : null;
    }
    function sampleNonNull(field, max) {
        var out = [];
        var ci = st.userMapping[field];
        if (ci == null || !st.columnSeries[ci]) return out;
        var col = st.columnSeries[ci];
        for (var i = 0; i < col.length && out.length < max; i++) {
            if (col[i] != null && String(col[i]).trim() !== '') out.push(col[i]);
        }
        return out;
    }
    function computeColumnWarnings() {
        var warns = [];

        // 1) ayni kaynak kolon birden cok kritik alana atanmis mi?
        var byCol = {};
        CRITICAL_FIELDS.forEach(function (f) {
            var ci = st.userMapping[f];
            if (ci == null) return;
            (byCol[ci] = byCol[ci] || []).push(f);
        });
        Object.keys(byCol).forEach(function (ci) {
            if (byCol[ci].length > 1) {
                var names = byCol[ci].map(function (f) { return FIELD_LABELS[f]; }).join(' / ');
                warns.push('Aynı kolon birden fazla alana atanmış: ' + names +
                    '. Her alan için ayrı sütun seçtiğinizden emin olun.');
            }
        });

        // 2) sayisal gorunmeyen kritik sayisal kolonlar
        ['raw_qty', 'raw_unit_price', 'raw_line_total'].forEach(function (f) {
            if (st.userMapping[f] == null) return;
            var s = sampleNonNull(f, 15);
            if (!s.length) return;
            var bad = s.filter(function (v) { return _np(v) == null; }).length;
            if (bad > s.length / 2) {
                warns.push('"' + FIELD_LABELS[f] + '" kolonu sayısal görünmüyor. ' +
                    'Doğru sütunu seçtiğinizden emin olun.');
            }
        });

        // 3) KDV anormal mi?
        if (st.userMapping.raw_vat != null) {
            var sv = sampleNonNull('raw_vat', 15).map(_np).filter(function (n) { return n != null; });
            var anom = sv.filter(function (n) { return n < 0 || n > 100; }).length;
            if (anom > 0) {
                warns.push('KDV kolonunda olağan dışı değerler var (0-100 dışında). Kontrol gerekli.');
            }
        }

        return warns;
    }
    function renderColWarnings() {
        var box = el('iv-colwarn');
        if (!box) return;
        var warns = computeColumnWarnings();
        box.innerHTML = warns.length
            ? '<div class="iv-warns">' + warns.map(function (w) {
                  return '<div class="iv-warn">⚠ ' + escapeHtml(w) + '</div>';
              }).join('') + '</div>'
            : '';
    }

    // ============================================================
    // 075-H-A: KONTROL OZETI (4 kart) — Satır / Kolon Durumu /
    //   Hesap Kontrolü / Genel Durum. Yalniz bilgilendirir; gonderimi
    //   bloklamaz (blok kurallari refreshSaveState'te).
    // ============================================================
    function computeSummary() {
        var rowCount = buildRawLinesFromTable().length;
        var hasName = st.userMapping.raw_name != null;
        var colWarns = computeColumnWarnings();

        // Kolon durumu
        var allCritical = CRITICAL_FIELDS.every(function (f) { return st.userMapping[f] != null; });
        var colStatus, colTone;
        if (!hasName) { colStatus = 'Eksik'; colTone = 'bad'; }
        else if (colWarns.length) { colStatus = 'Kontrol Gerekli'; colTone = 'warn'; }
        else if (allCritical) { colStatus = 'Tam'; colTone = 'ok'; }
        else { colStatus = 'Eksik'; colTone = 'warn'; }

        // Hesap kontrolu — 'check' donen satir sayisi
        var warnCount = 0;
        var canMath = window.ImportParsers && ImportParsers.validateLineMath;
        if (canMath) {
            for (var i = 0; i < rowCount; i++) {
                var r = ImportParsers.validateLineMath(lineAt(i));
                if (r && r.status === 'check') warnCount++;
            }
        }
        var acctText, acctTone;
        if (!canMath || rowCount === 0) { acctText = '—'; acctTone = 'muted'; }
        else if (warnCount === 0) { acctText = 'Uyumlu'; acctTone = 'ok'; }
        else { acctText = warnCount + ' uyarı'; acctTone = 'warn'; }

        // Genel durum — gonderim kosullari (raw_name + 0<satir<=MAX)
        var ready = hasName && rowCount > 0 && rowCount <= MAX_ROWS;
        var genText = ready ? 'Eşleştirmeye Hazır' : 'Kontrol Gerekli';
        var genTone = ready ? 'ok' : 'warn';

        return {
            rowCount: rowCount,
            colStatus: colStatus, colTone: colTone,
            acctText: acctText, acctTone: acctTone,
            genText: genText, genTone: genTone
        };
    }
    function cardHtml(value, tone, title) {
        var c = STATUS_COLORS[tone] || STATUS_COLORS.muted;
        return '<div class="iv-card" style="border-color:' + c.bg + ';">' +
            '<div class="n" style="color:' + c.fg + ';">' + escapeHtml(value) + '</div>' +
            '<div class="t">' + escapeHtml(title) + '</div></div>';
    }
    function renderCards() {
        var box = el('iv-cards');
        if (!box) return;
        var s = computeSummary();
        box.innerHTML = '<div class="iv-cards">' +
            cardHtml(s.rowCount + ' satır', s.rowCount > 0 ? 'ok' : 'bad', 'Satır') +
            cardHtml(s.colStatus, s.colTone, 'Kolon Durumu') +
            cardHtml(s.acctText, s.acctTone, 'Hesap Kontrolü') +
            cardHtml(s.genText, s.genTone, 'Genel Durum') +
        '</div>';
    }

    // ============================================================
    // PREVIEW (075-G/1) — kullanici mapping'ine gore basliklar + degerler.
    //   Dosyadan gelen ham basliklar DEGIL; FIELD_LABELS (Ürün, Miktar, Birim,
    //   Faturadaki Birim Fiyat, KDV, İskonto, Faturadaki Satır Tutarı).
    //   Degerler: field → colIndex → columnSeries[colIndex][i] (eslesmemis → bos).
    // ============================================================
    function renderPreview() {
        var box = el('iv-preview');
        if (!box) return;
        var n = Math.min(dataRowCount(), PREVIEW_ROW_LIMIT);
        var canMath = window.ImportParsers && ImportParsers.validateLineMath;
        var thead = '<tr>' + MAPPABLE_FIELDS.map(function (f) {
            return '<th>' + escapeHtml(FIELD_LABELS[f]) + '</th>';
        }).join('') + '<th>Kontrol Durumu</th></tr>';
        var body = '';
        for (var i = 0; i < n; i++) {
            var cells = MAPPABLE_FIELDS.map(function (f) {
                var ci = st.userMapping[f];
                var v = (ci != null && st.columnSeries[ci]) ? st.columnSeries[ci][i] : null;
                return '<td>' + escapeHtml(v == null ? '' : v) + '</td>';
            }).join('');
            // Kontrol Durumu rozeti
            var stCell = '<td><span class="iv-st" style="color:' + STATUS_COLORS.muted.fg +
                ';background:' + STATUS_COLORS.muted.bg + ';">—</span></td>';
            if (canMath) {
                var r = ImportParsers.validateLineMath(lineAt(i));
                var tone = STATUS_COLORS[MATH_TONE[r.code]] || STATUS_COLORS.muted;
                stCell = '<td><span class="iv-st" title="' + escapeHtml(r.hint || '') +
                    '" style="color:' + tone.fg + ';background:' + tone.bg + ';">' +
                    escapeHtml(r.label) + '</span></td>';
            }
            body += '<tr>' + cells + stCell + '</tr>';
        }
        box.innerHTML = '<div class="iv-tablewrap"><table class="iv-table"><thead>' +
            thead + '</thead><tbody>' + body + '</tbody></table></div>';
    }

    function metaCell(label, val) {
        return '<div><b>' + label + ':</b> ' + escapeHtml(val != null && val !== '' ? val : '—') + '</div>';
    }

    // ============================================================
    // SAVE STATE — efektif (gercekte gonderilecek) satir sayisi uzerinden
    // ============================================================
    function refreshSaveState() {
        var effective = buildRawLinesFromTable().length;
        var hasName = st.userMapping.raw_name != null;

        if (effective === 0) {
            setSave(false, 'Aktarılacak satır bulunamadı.');
            return;
        }
        if (effective > MAX_ROWS) {
            setSave(false, 'Bu dosyada ' + effective + ' satır var (sınır ' + MAX_ROWS +
                '). Tek fatura için fazla büyük görünüyor; lütfen dosyayı bölerek tekrar yükleyin.');
            return;
        }
        if (!hasName) {
            setSave(false, 'Ürün kolonu seçilmeden eşleştirmeye gönderilemez.');
            return;
        }
        setSave(true, effective + ' satır eşleştirmeye göndermeye hazır.');
    }

    function setSave(enabled, countMsg) {
        var b = el('iv-save'); var c = el('iv-count');
        if (b) b.disabled = !enabled;
        if (c) c.textContent = countMsg || '';
    }

    // ============================================================
    // STAGING'E KAYDET → RPC
    // ============================================================
    function buildPayload() {
        var lines = buildRawLinesFromTable();
        var m = st.parse.batchMeta;
        // 076-L.2: metadata tek-standart kaynak = parse_meta.detected_meta; bm alanlari fallback.
        var dm = (m.parse_meta && m.parse_meta.detected_meta) || {};
        var meta = {
            source_type: m.source_type,
            original_filename: m.original_filename,
            file_hash: m.file_hash,
            sheet_name: m.sheet_name,
            delimiter: m.delimiter,
            encoding: m.encoding,
            detected_header_row: m.detected_header_row,
            column_mapping: st.userMapping,           // guncel kullanici mapping'i
            parse_meta: m.parse_meta || {},
            // 076-L: parser'in profesyonel XLSX'ten yakaladigi metadata (varsa).
            //   import_stage_batch bunlari import_batches'e yazar (invoice_date/
            //   supplier_raw_text/invoice_external_no/declared_total). delivery/due
            //   staging'de yok → onSave sonrasi import_set_invoice_meta ile yazilir.
            invoice_date:        m.invoice_date || dm.invoice_date || null,
            supplier_raw_text:   m.supplier_raw_text || dm.supplier || null,
            invoice_external_no: m.invoice_external_no || dm.invoice_no || null,
            declared_total:      (m.declared_total != null ? m.declared_total : null),
            // 076-L.4: genel iskonto (varsa) — staging import_batches'e yazar; commit engeller.
            general_discount_amount: (m.general_discount_amount != null ? m.general_discount_amount : null),
            general_discount_type:   m.general_discount_type || null
        };
        return { p_meta: meta, p_lines: lines };
    }

    async function onSave() {
        if (_submitting) return;          // 075-G cift-gonderim guard
        if (!st) return;
        var b = el('iv-save');
        if (b && b.disabled) return;

        var payload = buildPayload();
        var effective = payload.p_lines.length;

        // son guvenlik kontrolleri (UI bypass'a karsi)
        if (effective === 0) { toastErr('Aktarılacak satır yok.'); return; }
        if (effective > MAX_ROWS) {
            toastErr('Bu dosyada ' + effective + '\'den fazla satır var. Tek fatura için fazla büyük görünüyor. ' +
                'Lütfen dosyayı bölerek tekrar yükleyin.');
            return;
        }
        if (st.userMapping.raw_name == null) {
            toastErr('Ürün kolonu seçilmeden eşleştirmeye gönderilemez.');
            return;
        }

        var client = window.SupabaseService && window.SupabaseService.getClient
            ? window.SupabaseService.getClient() : null;
        if (!client) { toastErr('Supabase bağlantısı bulunamadı.'); return; }

        // Cift-tik engeli: butonu HEMEN kilitle.
        _submitting = true;
        if (b) { b.disabled = true; b.textContent = 'Gönderiliyor…'; }

        var resp;
        try {
            resp = await client.rpc('import_stage_batch', {
                p_meta: payload.p_meta,
                p_lines: payload.p_lines
            });
        } catch (e) {
            _submitting = false;
            if (b) { b.disabled = false; b.textContent = SAVE_LABEL; }
            toastErr('Gönderim sırasında hata: ' + (e && e.message ? e.message : 'bilinmeyen'));
            return;
        }

        if (resp && resp.error) {
            _submitting = false;
            if (b) { b.disabled = false; b.textContent = SAVE_LABEL; }
            toastErr('Hata: ' + (resp.error.message || 'gönderim başarısız'));
            return;
        }

        var data = resp && resp.data ? resp.data : null;
        // batch_id key kontrolu (response yapisi: { ok, batch_id, ... })
        var batchId = data && (data.batch_id || data.batchId || data.id);

        if (data && data.duplicate_warning === true) {
            toastInfo('Bu dosya daha önce yüklenmiş olabilir.');
        }

        // 076-L: parser irsaliye/son ödeme yakaladıysa import_batches'e yaz
        //   (import_stage_batch bu iki alanı yazmaz; import_set_invoice_meta ile).
        //   Başarısız/RPC yoksa sessiz — tarihler review ekranında manuel girilebilir.
        var bm = st.parse.batchMeta || {};
        var dm2 = (bm.parse_meta && bm.parse_meta.detected_meta) || {};
        var invD = bm.invoice_date  || dm2.invoice_date  || null;
        var delD = bm.delivery_date || dm2.delivery_date || null;
        var dueD = bm.due_date      || dm2.due_date      || null;
        // 076-L.2: herhangi bir tarih tespit edildiyse import_batches'e yaz (invoice_date
        //   staging'de yazilmis olsa da tekrar yazmak zararsiz; delivery/due YALNIZ burada).
        if (batchId && (invD || delD || dueD)) {
            try {
                await client.rpc('import_set_invoice_meta', {
                    p_batch_id: batchId,
                    p_invoice_date: invD,
                    p_delivery_date: delD,
                    p_due_date: dueD
                });
            } catch (e) { /* sessiz — manuel giriş devam eder */ }
        }

        _submitting = false;
        close();

        // Basari → otomatik review ekranina goturur; batch_id yoksa bilgilendir.
        if (batchId && window.ImportReviewView && window.ImportReviewView.open) {
            toastOk('Fatura yüklendi.');
            window.ImportReviewView.open(batchId);
        } else {
            toastOk('Fatura yüklendi. Eşleştirme Bekleyenler\'den açabilirsiniz.');
        }
    }

    // ============================================================
    // PUBLIC
    // ============================================================
    function open() {
        if (el('iv-overlay')) return; // zaten acik
        injectStyles();
        buildModal();
    }

    return { open: open };
})();

/* ============================================================
   073-C2 MAPPING NOTU (table-based)
   ------------------------------------------------------------
   - Dropdown secenekleri parse.table.columns'tan gelir → TUM kolonlar
     (parser'in otomatik tanimadiklari dahil). Ornek: "Mal Aciklamasi"
     otomatik raw_name taninmasa bile dropdown'da yer alir; kullanici secer.
   - p_lines, kullanici mapping'i ile parse.table.rows uzerinden YENIDEN
     uretilir (buildRawLinesFromTable): field → colIndex → satir degeri.
   - colIndex ORIJINAL kolon indeksidir → batchMeta.column_mapping ve
     table.columns[].index ile birebir hizali.
   - table yoksa eski rawLines/column_mapping yoluna FALLBACK (geriye uyum).
   - 2000 satir ve raw_name kontrolleri EFEKTIF (gercekte gonderilecek)
     p_lines sayisina gore yapilir — RPC'nin 2000 limitiyle birebir.

   GUVENLIK / KAPSAM:
     - Yeni Supabase client kurulmadi; window.SupabaseService.getClient kullanildi.
     - Hardcoded URL/key YOK.
     - purchase_items / cost chain / commit / matching'e DOKUNULMADI.
     - Tek yazma yolu: import_stage_batch RPC (073-A, DEFINER, staging-only).
   ============================================================ */
