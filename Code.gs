/**
 * ====================================================================
 *  EVALUASI WAWANCARA CALON MAHASISWA MM — Apps Script Backend
 * ====================================================================
 *  Menerima kiriman dari formulir (index.html) dan menyimpannya
 *  sebagai baris baru di tab "Responses" pada Google Spreadsheet ini.
 *
 *  Cara pasang:
 *  1. Buka Google Spreadsheet -> menu Extensions -> Apps Script
 *  2. Hapus isi Code.gs bawaan, tempel seluruh isi file ini, simpan.
 *  3. Deploy -> New deployment -> Web app
 *       - Execute as   : Me
 *       - Who has access: Anyone
 *  4. Copy URL /exec -> paste ke CONFIG.SCRIPT_URL di index.html
 *
 *  PENTING — pembaruan dari versi lama:
 *  Bila tab "Responses" dibuat oleh versi sebelumnya (belum ada kolom
 *  "Nama Interviewer"), fungsi ensureLatestColumns_ otomatis menyisipkan
 *  kolom tersebut pada penyimpanan berikutnya. Bisa juga dijalankan
 *  manual lewat menu "Form MM -> Migrasi kolom Nama Interviewer".
 *  Setelah mengganti isi Code.gs, WAJIB deploy ulang versi baru:
 *  Deploy -> Manage deployments -> Edit -> Version: New version.
 *
 *  Pembaruan terbaru:
 *  - Anti-duplikat: formulir mengirim "id" unik per pengiriman; bila id
 *    yang sama masuk lagi (mis. fallback JSONP setelah POST berhasil),
 *    server tidak menulis baris baru dan mengembalikan nomor baris lama.
 *  - Kode akses opsional (ACCESS_TOKEN) untuk kirim data & ambil daftar.
 *  - ?action=candidates kini menyertakan "done" (calon yang sudah
 *    diwawancarai, dibaca dari tab Responses) untuk tanda centang di form.
 *
 *  Detail lengkap ada di README.md.
 * ====================================================================
 */

/** Nama tab tujuan penyimpanan data. */
const SHEET_NAME = 'Responses';

/** Nama tab sumber daftar interviewer + calon mahasiswa + profil.
 *  Kolom A = Nama Interviewer, kolom B = Nama Calon Mahasiswa,
 *  kolom C dst = field profil (judul kolom dipakai sebagai label).
 *  Nilai sel boleh multi-baris (Alt+Enter) atau dipisah "|" -> tampil
 *  sebagai daftar bernomor pada formulir. */
const CANDIDATE_SHEET_NAME = 'Candidates';

/** Zona waktu untuk format tanggal pada pesan respons. */
const TIMEZONE = 'Asia/Jakarta';

/** Skor maksimum (10 kriteria x nilai 4). */
const MAX_SCORE = 40;

/**
 * (Opsional) Kode akses bersama. Biarkan '' untuk menonaktifkan.
 * Bila diisi, harus SAMA PERSIS dengan CONFIG.ACCESS_TOKEN di index.html.
 * Catatan: kode ini terlihat di sumber halaman, jadi hanya mencegah
 * penyalahgunaan sembarangan -- bukan rahasia sungguhan.
 */
const ACCESS_TOKEN = '';

/** Lama (detik) ID pengiriman diingat untuk mendeteksi duplikat (6 jam). */
const DEDUPE_TTL_SECONDS = 21600;

/**
 * (Opsional) Isi ID Spreadsheet bila script TIDAK dibuat dari dalam
 * Spreadsheet (script berdiri sendiri). Bila dibiarkan kosong dan
 * script dibuat dari Extensions -> Apps Script, otomatis memakai
 * Spreadsheet tempat script berada.
 */
const SPREADSHEET_ID = '';

/** Urutan & judul kolom pada tab Responses. Harus sama dengan form. */
const HEADERS = [
  'Timestamp',
  'Nama Interviewer',
  'Nama Calon Mahasiswa',
  'A1 - Kematangan bersikap & berpenampilan profesional',
  'B1 - Kejelasan tujuan/motivasi menempuh pendidikan MM',
  'B2 - Kemampuan mengembangkan diri untuk masa depan',
  'C1 - Pengetahuan/wawasan bisnis & manajemen',
  'C2 - Kemampuan mengambil keputusan & kreatif',
  'D1 - Menyampaikan pendapat secara efektif',
  'D2 - Menyampaikan gagasan dengan argumen logis',
  'D3 - Komunikasi dalam bahasa Inggris',
  'E1 - Komitmen proses pendidikan MM (5P)',
  'E2 - Komitmen berperilaku etis (5I)',
  'Potensi Program IMBA',
  'Pilihan Bidang Minat',
  'Hasil Wawancara',
  'Catatan Tambahan',
  'Total Skor (max 40)',
  'Persentase (%)'
];

/** Warna baris Hasil Wawancara agar mudah dipindai. */
const RESULT_COLORS = {
  'Highly Recommended (HR)': '#b7e1cd',
  'Recommended (R)':         '#fce8b2',
  'Not Recommended (NR)':    '#f4c7c3'
};

/** Judul kolom tab Candidates (contoh). Kolom A & B wajib; kolom profil
 *  boleh ditambah/diubah/dihapus sesuai kebutuhan -- judul kolom menjadi
 *  label baris profil pada formulir. */
const CANDIDATE_HEADERS = [
  'Nama Interviewer',
  'Nama Calon Mahasiswa',
  'Program',
  'Bidang konsentrasi',
  'Program Studi S1',
  'Fakultas S1',
  'Universitas S1',
  'Lama studi S1 (tahun)',
  'Pengalaman organisasi/bisnis/kerja',
  'Jabatan & institusi saat ini',
  '3 prestasi terbaik',
  'Skor TBI',
  'Skor TPA'
];

/* ====================================================================
 *  ENDPOINT
 * ==================================================================== */

/** Dipanggil formulir via fetch POST (body = JSON string). */
function doPost(e) {
  return saveSubmission_(parseBody_(e), null);
}

/**
 * Dipanggil browser saat membuka URL /exec langsung (cek deployment),
 * atau oleh formulir sebagai jalur cadangan JSONP (?data=...&callback=...).
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.data) return saveSubmission_(safeJson_(p.data), p.callback || null);
  if (p.action === 'candidates') {
    if (ACCESS_TOKEN && p.token !== ACCESS_TOKEN) {
      return respond_({ status: 'error', message: 'Akses ditolak.' }, p.callback || null);
    }
    return respond_(getCandidates(), p.callback || null);
  }
  return respond_({
    status: 'success',
    app: 'Evaluasi Wawancara MM',
    message: 'Web App aktif dan siap menerima data formulir.',
    time: Utilities.formatDate(new Date(), TIMEZONE, 'dd MMM yyyy HH:mm:ss')
  }, p.callback || null);
}

/* ====================================================================
 *  DAFTAR CALON + PROFIL (tab Candidates)
 * ====================================================================
 *  Formulir memanggil ?action=candidates saat halaman dibuka, lalu
 *  mengganti daftar dropdown & profil di index.html dengan data dari
 *  tab ini. Satu baris = satu calon mahasiswa.
 */

/** Baca tab Candidates -> { status, interviewers: { nama: [calon...] } }.
 *  Calon tanpa field profil dikirim sebagai string; dengan profil
 *  dikirim sebagai { nama, profil }. Struktur sama dengan CONFIG
 *  INTERVIEWERS di index.html. */
function getCandidates() {
  try {
    const ss = getSpreadsheet_();
    const sh = ss.getSheetByName(CANDIDATE_SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) {
      return { status: 'success', interviewers: {}, message: 'Tab ' + CANDIDATE_SHEET_NAME + ' kosong/belum ada.' };
    }
    const values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    const header = values[0].map(function (h) { return String(h).trim(); });

    const ivCol = header.findIndex(function (h) { return /^nama\s*interviewer$/i.test(h); });
    const nmCol = header.findIndex(function (h) { return /^nama\s*calon/i.test(h); });
    if (ivCol === -1 || nmCol === -1) {
      return { status: 'error', message: 'Tab ' + CANDIDATE_SHEET_NAME + ' wajib punya kolom "Nama Interviewer" dan "Nama Calon Mahasiswa".' };
    }

    const profileCols = [];
    for (let c = 0; c < header.length; c++) {
      if (header[c] && c !== ivCol && c !== nmCol) profileCols.push(c);
    }

    const map = {};
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const iv = str_(row[ivCol]);
      const nm = str_(row[nmCol]);
      if (!iv || !nm) continue;                       // lewati baris kosong
      const profil = {};
      profileCols.forEach(function (c) {
        const raw = row[c];
        let v = '';
        if (raw instanceof Date) v = Utilities.formatDate(raw, TIMEZONE, 'yyyy-MM-dd');
        else if (raw !== null && raw !== undefined) v = str_(raw);
        if (v === '') return;
        const parts = v.split(/\r?\n|\s*\|\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
        profil[header[c]] = parts.length > 1 ? parts : parts[0];
      });
      if (!map[iv]) map[iv] = [];
      map[iv].push(Object.keys(profil).length ? { nama: nm, profil: profil } : nm);
    }
    return { status: 'success', interviewers: map, done: getDoneMap_() };
  } catch (err) {
    return { status: 'error', message: 'Gagal membaca tab ' + CANDIDATE_SHEET_NAME + ': ' + err.message };
  }
}

/** Daftar calon yang SUDAH diwawancarai, dibaca dari tab Responses:
 *  { "Nama Interviewer": ["Nama Calon", ...] }. Formulir memakainya untuk
 *  menampilkan tanda centang pada daftar calon. Bila gagal/kosong -> {}
 *  (daftar calon tetap berfungsi tanpa tanda). */
function getDoneMap_() {
  try {
    const sh = getSpreadsheet_().getSheetByName(SHEET_NAME);
    if (!sh || sh.getLastRow() < 2) return {};
    const values = sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), 3)).getValues();
    const header = values[0].map(function (h) { return String(h).trim(); });
    const ivCol = header.indexOf('Nama Interviewer');
    const nmCol = header.indexOf('Nama Calon Mahasiswa');
    if (ivCol === -1 || nmCol === -1) return {};
    const done = {};
    for (let r = 1; r < values.length; r++) {
      const iv = str_(values[r][ivCol]);
      const nm = str_(values[r][nmCol]);
      if (!iv || !nm || iv === 'DATA UJI') continue;      // lewati baris kosong & baris uji coba
      if (!done[iv]) done[iv] = [];
      if (done[iv].indexOf(nm) === -1) done[iv].push(nm);
    }
    return done;
  } catch (err) {
    return {};
  }
}

/** Boleh dijalankan manual (Run / menu "Form MM") untuk membuat tab
 *  Candidates lengkap dengan contoh isi. Aman dijalankan ulang: baris
 *  contoh hanya ditulis bila tab masih kosong. */
function setupCandidatesSheet() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CANDIDATE_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(CANDIDATE_SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow(CANDIDATE_HEADERS);
    sh.getRange(1, 1, 1, CANDIDATE_HEADERS.length)
      .setFontWeight('bold')
      .setFontColor('#ffffff')
      .setBackground('#4f46e5')
      .setVerticalAlignment('middle')
      .setWrap(true);
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 150);
    sh.setColumnWidth(2, 170);
    for (let c = 3; c <= CANDIDATE_HEADERS.length; c++) sh.setColumnWidth(c, 240);
    sh.getRange(2, 3, Math.max(sh.getMaxRows() - 1, 1), CANDIDATE_HEADERS.length - 2).setWrap(true);
    sh.getRange(2, 1, sh.getMaxRows() - 1, CANDIDATE_HEADERS.length).setVerticalAlignment('top');

    /* Contoh isi fiktif (hapus/ubah sesuai data asli) */
    sh.getRange(2, 1, 3, CANDIDATE_HEADERS.length).setValues([
      ['Interviewer A', 'Jacky Chan', 'Regular MBA', 'Finance', 'Manajemen', 'Fakultas Ekonomi dan Bisnis', 'Universitas Contoh', '3.5',
       'Magang Staf Operasional di PT Contoh Maju (2024)\nAsisten Laboratorium Kewirausahaan, Universitas Contoh (2024)\nKetua Divisi Acara, Himpunan Mahasiswa Manajemen (2023)',
       'Staf Administrasi di PT Contoh Indonesia',
       'Juara 1 Lomba Business Plan Tingkat Universitas (2023)\nJuara 2 Debat Bahasa Inggris Tingkat Regional (2022)\nPenerima Beasiswa Prestasi Akademik (2021)',
       '500', '600'],
      ['Interviewer A', 'John', '', '', '', '', '', '', '', '', '', '', ''],
      ['Interviewer B', 'Hasan', '', '', '', '', '', '', '', '', '', '', '']
    ]);
  }
  return sh;
}

/* ====================================================================
 *  SIMPAN DATA
 * ==================================================================== */

function saveSubmission_(data, jsonpCallback) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);

    /* ---------- Kode akses (opsional) ---------- */
    if (ACCESS_TOKEN && str_(data.token) !== ACCESS_TOKEN) {
      return respond_({ status: 'error', message: 'Akses ditolak.' }, jsonpCallback);
    }

    /* ---------- Validasi ---------- */
    const nama = str_(data.nama);
    const scores = (data && data.scores) || {};
    const ids = ['A1', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2', 'D3', 'E1', 'E2'];

    const missing = [];
    if (!str_(data.interviewer)) missing.push('Nama Interviewer');
    if (!nama) missing.push('Nama Calon Mahasiswa');
    ids.forEach(function (id) {
      if (!isValidScore_(scores[id])) missing.push(id);
    });
    if (!str_(data.imba)) missing.push('Potensi IMBA');
    if (!str_(data.minat)) missing.push('Bidang Minat');
    if (!str_(data.hasil)) missing.push('Hasil Wawancara');
    if (missing.length) {
      return respond_({ status: 'error', message: 'Data belum lengkap: ' + missing.join(', ') }, jsonpCallback);
    }

    /* ---------- Cegah duplikat (ID unik dari formulir) ---------- */
    const subId = str_(data.id);
    const cache = CacheService.getScriptCache();
    const prevRow = subId ? cache.get('sub_' + subId) : null;
    if (prevRow) {
      return respond_({
        status: 'success',
        message: 'Data sudah tersimpan sebelumnya.',
        row: Number(prevRow),
        duplicate: true
      }, jsonpCallback);
    }

    /* ---------- Hitung skor ---------- */
    const total = ids.reduce(function (sum, id) { return sum + Number(scores[id]); }, 0);
    const pct = Math.round((total / MAX_SCORE) * 100);

    /* ---------- Tulis ke Spreadsheet ---------- */
    const sheet = getSheet_();
    const row = [new Date(), str_(data.interviewer), nama]
      .concat(ids.map(function (id) { return Number(scores[id]); }))
      .concat([str_(data.imba), str_(data.minat), str_(data.hasil), str_(data.catatan), total, pct]);

    sheet.appendRow(row);
    const rowNum = sheet.getLastRow();
    paintResult_(sheet, rowNum, str_(data.hasil));

    /* Ingat ID hanya setelah penulisan berhasil (percobaan gagal tetap bisa diulang). */
    if (subId) cache.put('sub_' + subId, String(rowNum), DEDUPE_TTL_SECONDS);

    return respond_({
      status: 'success',
      message: 'Data tersimpan.',
      row: rowNum,
      totalScore: total,
      percent: pct
    }, jsonpCallback);
  } catch (err) {
    return respond_({ status: 'error', message: 'Gagal menyimpan: ' + err.message }, jsonpCallback);
  } finally {
    try { lock.releaseLock(); } catch (e2) { /* ignore */ }
  }
}

/* ====================================================================
 *  HELPERS
 * ==================================================================== */

function getSpreadsheet_() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** Ambil tab Responses; buat otomatis bila belum ada, lalu pastikan
 *  susunan kolomnya sudah versi terbaru (dengan "Nama Interviewer"). */
function getSheet_() {
  const sheet = getSpreadsheet_().getSheetByName(SHEET_NAME) || setupSheet();
  ensureLatestColumns_(sheet);
  return sheet;
}

/** Boleh dijalankan manual (Run di editor / menu "Form MM") untuk membuat
 *  atau memperbaiki tab Responses + header + format. Aman dijalankan ulang. */
function setupSheet() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    applyHeaderFormat_(sh);
    applyColumnLayout_(sh);
    sh.setFrozenRows(1);
  } else {
    ensureLatestColumns_(sh);   // rapikan bila susunan kolom masih versi lama
  }
  return sh;
}

/* ====================================================================
 *  MIGRASI KOLOM (sheet lama -> format terbaru)
 * ====================================================================
 *  Tab "Responses" yang dibuat oleh versi Code.gs sebelumnya belum
 *  memiliki kolom "Nama Interviewer". Fungsi ini memastikan header &
 *  data selaras dengan format terbaru:
 *    Kasus 1: sheet lama murni (18 kolom, tanpa Interviewer)
 *             -> sisipkan kolom B, geser data lama ke kanan otomatis.
 *    Kasus 2: header masih lama tetapi sudah ada baris baru berisi
 *             19 kolom (terjadi bila Code.gs baru terlanjur dipakai)
 *             -> cukup perbaiki judul + rapikan baris lama, TANPA
 *                menyisip kolom (agar tidak bergeser dua kali).
 *  Aman dijalankan berulang; bila header sudah sesuai, tidak ada aksi.
 */
function ensureLatestColumns_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) return false;            // tab kosong: setupSheet() yang mengatur

  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const current = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
                    .map(function (h) { return String(h).trim(); });

  const isCurrent = current.length >= HEADERS.length &&
    HEADERS.every(function (h, i) { return current[i] === h; });
  if (isCurrent) return false;                // sudah yang terbaru -> tidak ada aksi

  const hasInterviewer = current.indexOf('Nama Interviewer') !== -1;
  if (!hasInterviewer && lastCol < HEADERS.length) {
    sheet.insertColumnBefore(2);              // Kasus 1: geser data lama ke kanan
  }

  /* Tulis ulang baris judul agar persis sama dengan konfigurasi. */
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  applyHeaderFormat_(sheet);
  applyColumnLayout_(sheet);

  repairLegacyRows_(sheet);                   // Kasus 2: sejajarkan baris lama
  return true;
}

/** Geser baris berformat lama (kolom C = angka skor, bukan nama) satu
 *  kolom ke kanan sehingga sejajar dengan header terbaru. */
function repairLegacyRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const width = Math.max(sheet.getLastColumn(), HEADERS.length);
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  let changed = false;
  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    if (String(row[0]).trim() === '') continue;                 // baris kosong
    const cVal = Number(row[2]);                                // kolom C
    const isLegacy = row[2] !== '' && !isNaN(cVal) && cVal >= 1 && cVal <= 4;
    if (!isLegacy) continue;                                    // sudah format baru
    const fixed = [row[0], '', row[1]];                         // Timestamp, Interviewer (kosong), Nama
    for (let c = 3; c < width; c++) fixed.push(row[c]);
    for (let c = 0; c < width; c++) values[r][c] = fixed[c] !== undefined ? fixed[c] : '';
    changed = true;
  }
  if (changed) sheet.getRange(2, 1, lastRow - 1, width).setValues(values);
}

/** Format tampilan baris judul tab Responses. */
function applyHeaderFormat_(sh) {
  sh.getRange(1, 1, 1, HEADERS.length)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#4f46e5')
    .setVerticalAlignment('middle')
    .setWrap(true);
}

/** Lebar kolom & perataan tab Responses. */
function applyColumnLayout_(sh) {
  sh.setColumnWidth(1, 150);   // Timestamp
  sh.setColumnWidth(2, 160);   // Nama Interviewer
  sh.setColumnWidth(3, 200);   // Nama Calon Mahasiswa
  for (let c = 4; c <= 13; c++) sh.setColumnWidth(c, 78);  // kolom skor
  sh.setColumnWidth(14, 130);  // IMBA
  sh.setColumnWidth(15, 210);  // Bidang Minat
  sh.setColumnWidth(16, 190);  // Hasil
  sh.setColumnWidth(17, 320);  // Catatan
  sh.setColumnWidth(18, 120);  // Total
  sh.setColumnWidth(19, 110);  // Persentase
  sh.getRange(2, 4, Math.max(sh.getMaxRows() - 1, 1), 10).setHorizontalAlignment('center'); // skor (D:M)
  sh.getRange('N2:N').setHorizontalAlignment('center');  // IMBA
  sh.getRange('R2:S').setHorizontalAlignment('center');  // Total + Persentase
  sh.getRange('Q2:Q').setWrap(true);                     // Catatan wrap
}

/** Warnai sel Hasil Wawancara sesuai pilihan (HR hijau, R kuning, NR merah). */
function paintResult_(sheet, rowNum, hasil) {
  const col = HEADERS.indexOf('Hasil Wawancara') + 1;
  const color = RESULT_COLORS[hasil];
  if (color) {
    sheet.getRange(rowNum, col).setBackground(color).setFontWeight('bold');
  }
}

function isValidScore_(v) {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && !isNaN(n) && n >= 1 && n <= 4;
}

function str_(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function parseBody_(e) {
  try {
    if (e && e.postData && e.postData.contents) return JSON.parse(e.postData.contents);
  } catch (err) { /* ignore */ }
  return {};
}

function safeJson_(s) {
  try { return JSON.parse(s); } catch (err) { return {}; }
}

/** Balas JSON biasa, atau JSONP bila ada callback (jalur cadangan form). */
function respond_(obj, jsonpCallback) {
  const out = JSON.stringify(obj);
  if (jsonpCallback) {
    return ContentService
      .createTextOutput(jsonpCallback + '(' + out + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(out)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ====================================================================
 *  UTILITAS OPSIONAL
 * ==================================================================== */

/** Menu bantu di dalam Spreadsheet. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Form MM')
    .addItem('Setup / perbaiki tab Responses', 'setupSheet')
    .addItem('Migrasi kolom Nama Interviewer', 'migrateSheetUI')
    .addItem('Setup tab Candidates (daftar + profil)', 'setupCandidatesSheet')
    .addItem('Isi 1 baris data uji coba', 'testSubmission')
    .addToUi();
}

/** Jalankan migrasi kolom secara manual dari menu "Form MM".
 *  Dipakai bila tab Responses lama belum punya kolom "Nama Interviewer". */
function migrateSheetUI() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = setupSheet();
  const changed = ensureLatestColumns_(sh);
  ss.toast(changed
    ? 'Kolom "Nama Interviewer" ditambahkan di kolom B. Baris lama tetap utuh (kolom Interviewer kosong).'
    : 'Susunan kolom tab ' + SHEET_NAME + ' sudah versi terbaru — tidak ada perubahan.',
    'Form MM', 8);
}

/** Sisipkan satu baris dummy untuk memastikan penulisan berjalan. */
function testSubmission() {
  const dummy = {
    token: ACCESS_TOKEN,    // lolos pemeriksaan kode akses bila diaktifkan
    interviewer: 'DATA UJI',
    nama: 'DATA UJI - hapus baris ini',
    scores: { A1: 4, B1: 3, B2: 3, C1: 4, C2: 2, D1: 3, D2: 3, D3: 2, E1: 4, E2: 3 },
    imba: 'YA',
    minat: 'Finance',
    hasil: 'Recommended (R)',
    catatan: 'Baris uji coba dari menu Form MM.'
  };
  const res = JSON.parse(saveSubmission_(dummy, null).getContent());
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Baris uji tersimpan di baris #' + res.row + ' (tab ' + SHEET_NAME + ').',
    'Form MM', 6
  );
}
