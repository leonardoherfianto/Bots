require('dotenv').config();
const { google } = require('googleapis');
const puppeteer = require('puppeteer-core');
const { saveAffiliateToDB } = require('./database'); 

const DEBUG_PORT = 9222;

// --- CONFIG GOOGLE SHEETS ---
const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SOURCE_SHEET = '01 Listing';
const TARGET_SHEET = '02 Analysis Shopee Global';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- HELPER: Parsing Waktu untuk Cek Duplikasi ---
function parseIdDate(dateStr) {
    if (!dateStr) return 0;
    try {
        // Contoh input dari Sheet: "2/3/2026, 11.32.44"
        const cleanStr = dateStr.replace(',', '').replace(/\./g, ':');
        const parts = cleanStr.trim().split(' ');
        
        if (parts.length < 2) return 0;
        
        const datePart = parts[0]; // "2/3/2026"
        const timePart = parts[1]; // "11:32:44"
        
        const [day, month, year] = datePart.split('/');
        
        // Pastikan day dan month memiliki 2 digit (02, 03, dst)
        const padDay = day.padStart(2, '0');
        const padMonth = month.padStart(2, '0');
        
        // Pastikan format waktu juga valid dengan 2 digit
        const timeArr = timePart.split(':');
        const padHour = (timeArr[0] || '00').padStart(2, '0');
        const padMin = (timeArr[1] || '00').padStart(2, '0');
        const padSec = (timeArr[2] || '00').padStart(2, '0');
        const formattedTime = `${padHour}:${padMin}:${padSec}`;
        
        // Format standar ISO: YYYY-MM-DDTHH:mm:ss
        const isoString = `${year}-${padMonth}-${padDay}T${formattedTime}`;
        const parsedDate = new Date(isoString).getTime();
        
        return isNaN(parsedDate) ? 0 : parsedDate;
    } catch (e) { 
        return 0; 
    }
}

// --- ALGORITMA KEMIRIPAN STRING (Levenshtein Distance) ---
function calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    str1 = str1.toLowerCase().trim();
    str2 = str2.toLowerCase().trim();
    if (str1 === str2) return 100;

    const costs = [];
    for (let i = 0; i <= str1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= str2.length; j++) {
            if (i === 0) costs[j] = j;
            else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (str1.charAt(i - 1) !== str2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[str2.length] = lastValue;
    }
    const distance = costs[str2.length];
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 100;
    return ((maxLen - distance) / maxLen) * 100;
}

// --- FUNGSI GOOGLE SHEETS ---
async function getTargetsFromSheet() {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SOURCE_SHEET}!A4:Z`, 
    });
    const rows = response.data.values || [];
    const targets = [];
    rows.forEach((row) => {
        const name = row[2]; 
        if (name && name.trim() !== "") targets.push(name.trim());
    });
    return targets;
}

async function getExistingDataMap() {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A:B`, 
        });
        const rows = response.data.values || [];
        const map = new Map();
        rows.forEach((row, index) => {
            if (row[1]) {
                map.set(row[1].trim().toLowerCase(), {
                    rowNumber: index + 1,
                    lastUpdate: row[0] || ''
                });
            }
        });
        return map;
    } catch (e) { return new Map(); }
}

async function saveToTargetSheet(rowData, existingRowNumber = null) {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    if (existingRowNumber && existingRowNumber !== -1) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A${existingRowNumber}:P${existingRowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   📝 Data Spreadsheet diperbarui pada baris ${existingRowNumber}`);
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A:P`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   ➕ Data Spreadsheet ditambahkan sebagai baris baru`);
    }
}

// --- FASE 1: AUTO HARVESTER SHOPEE ---
async function harvestShopeeHeaders(page) {
    return new Promise(async (resolve) => {
        console.log(`\n🕵️‍♂️ [AUTO-HARVEST] Membuka Shopee KOL Marketplace untuk memanen headers...`);
        let headersFound = false;
        let capturedHeaders = null;

        const requestInterceptor = (request) => {
            const url = request.url();
            if (url.includes('/api/v3/affiliateplatform/creator/list')) {
                const headers = request.headers();
                if (headers['x-sap-sec'] && !headersFound) {
                    console.log("🎯 [BINGO] Headers keamanan Shopee berhasil ditangkap!");
                    headersFound = true;
                    capturedHeaders = {
                        "accept": headers['accept'] || "application/json, text/plain, */*",
                        "af-ac-enc-dat": headers['af-ac-enc-dat'],
                        "af-ac-enc-sz-token": headers['af-ac-enc-sz-token'],
                        "content-type": headers['content-type'] || "application/json; charset=UTF-8",
                        "x-sap-ri": headers['x-sap-ri'],
                        "x-sap-sec": headers['x-sap-sec'],
                        "cookie": headers['cookie'] || headers['Cookie']
                    };
                }
            }
        };

        page.on('request', requestInterceptor);
        try {
            await page.bringToFront();
            await page.goto('https://seller.shopee.co.id/portal/web-seller-affiliate/kol_marketplace', { waitUntil: 'networkidle2', timeout: 60000 });
            await sleep(5000); 
            page.off('request', requestInterceptor);

            if (headersFound && capturedHeaders) resolve(capturedHeaders);
            else resolve(null);
        } catch (err) {
            page.off('request', requestInterceptor);
            resolve(null);
        }
    });
}

// --- MAIN BOT LOGIC ---
async function runShopeeBot() {
    try {
        console.log("📥 [Shopee] Mengambil daftar target dari Spreadsheet...");
        let rawDataset = await getTargetsFromSheet();

        if (rawDataset.length === 0) return console.log("⚠️ Tidak ada target ditemukan.");
        
        console.log("🔍 Mengecek histori data di Target Sheet...");
        const existingDataMap = await getExistingDataMap();

        // 1 MINGGU DALAM MILIDETIK (7 Hari * 24 Jam * 60 Menit * 60 Detik * 1000)
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const nowMs = Date.now();

        // Transformasi dataset string menjadi object agar bisa di-sort
        let dataset = rawDataset.map(name => ({ name }));

        // --- FASE 1: PEMETAAN & EVALUASI WAKTU UPDATE ---
        for (let item of dataset) {
            const existingData = existingDataMap.get(item.name.toLowerCase());
            
            if (existingData) {
                item.lastUpdateMs = parseIdDate(existingData.lastUpdate);
                item.existingRowNumber = existingData.rowNumber;
                item.isNew = false;
            } else {
                item.lastUpdateMs = 0; // Priority: 0 agar diurutkan paling pertama
                item.existingRowNumber = -1;
                item.isNew = true;
            }
        }

        // --- FASE 2: PENGURUTAN (SORTING) ---
        // Urutkan dari data baru/paling lama belum diupdate ke yang terbaru.
        dataset.sort((a, b) => a.lastUpdateMs - b.lastUpdateMs);

        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        const dynamicHeaders = await harvestShopeeHeaders(page);
        if (!dynamicHeaders) {
            console.log("❌ Auto-Harvest gagal. Hentikan operasi Shopee.");
            browser.disconnect(); return;
        }

        console.log("📚 Memuat Kamus Kategori Shopee dari Server...");
        const categoryMap = {};
        try {
            const catResponse = await page.evaluate(async (headersObj) => {
                const res = await fetch("https://seller.shopee.co.id/api/v3/affiliateplatform/commissions/category_setting", { headers: headersObj });
                return await res.json();
            }, dynamicHeaders);

            if (catResponse && catResponse.data && catResponse.data.category_list) {
                catResponse.data.category_list.forEach(c => {
                    categoryMap[c.category_id] = c.tag_name_by_lang;
                });
                console.log(`✅ ${Object.keys(categoryMap).length} Kategori berhasil dipetakan.`);
            }
        } catch (e) {
            console.log("⚠️ Gagal memuat kamus kategori, ID Kategori akan digunakan sebagai fallback.");
        }

        let processCounter = 0;
        const ages_range = ["0-12", "13-17", "18-22", "23-32", "33-42", "43-52", "53+"];

        for (let item of dataset) {
            processCounter++;
            const { name: targetName, lastUpdateMs, existingRowNumber, isNew } = item;

            // CEK COOLDOWN 1 MINGGU UNTUK DATA LAMA
            if (!isNew && (nowMs - lastUpdateMs) < ONE_WEEK_MS) {
                console.log(`\n[${processCounter}/${dataset.length}] ⏭️ Melewati ${targetName} (Data diperbarui kurang dari 1 minggu yang lalu)`);
                continue; 
            }

            if (isNew) {
                console.log(`\n[${processCounter}/${dataset.length}] ➕ Target Baru Ditemukan: ${targetName}`);
            } else {
                console.log(`\n[${processCounter}/${dataset.length}] 🔄 Memperbarui Data Lama: ${targetName}`);
            }

            try {
                await page.bringToFront();

                const apiResponse = await page.evaluate(async (affName, headersObj) => {
                    try {
                        const payload = {
                            "offset": 0, "page_type": "ams_kol_marketplace", "limit": 12,
                            "request_id": "9d2fd277-063c-434a-84aa-d9be845bf4bf", 
                            "is_liked_kol": false, "affiliate_name": affName, "show_meta_link": 1
                        };
                        const response = await fetch("https://seller.shopee.co.id/api/v3/affiliateplatform/creator/list", {
                            headers: headersObj, body: JSON.stringify(payload), method: "POST"
                        });
                        return await response.json();
                    } catch (e) { return { error: e.message }; }
                }, targetName, dynamicHeaders);

                if (apiResponse.error || apiResponse.code !== 0) {
                    console.log(`   ❌ Fetch Error / Ditolak: ${apiResponse.error || apiResponse.msg}`);
                    continue;
                }

                const dataList = apiResponse.data?.list || [];
                if (dataList.length === 0) {
                    console.log(`   ℹ️ User '${targetName}' tidak ditemukan.`);
                    continue;
                }

                let bestMatch = null;
                let highestMatchScore = -1;

                dataList.forEach(resultItem => {
                    let matchScores = [];
                    matchScores.push(calculateSimilarity(targetName, resultItem.display_name));
                    matchScores.push(calculateSimilarity(targetName, resultItem.username));
                    if (resultItem.social_medias && Array.isArray(resultItem.social_medias)) {
                        resultItem.social_medias.forEach(sm => {
                            if (sm.social_media_user_name) matchScores.push(calculateSimilarity(targetName, sm.social_media_user_name));
                        });
                    }
                    let maxScoreForItem = Math.max(...matchScores);
                    if (maxScoreForItem > highestMatchScore) {
                        highestMatchScore = maxScoreForItem;
                        bestMatch = resultItem;
                    }
                });

                if (!bestMatch) continue;
                console.log(`   🎯 Match Terbaik: ${bestMatch.display_name} (Akurasi: ${highestMatchScore.toFixed(2)}%)`);
                
                const finalData = {
                    affiliate_id: bestMatch.affiliate_id,
                    display_name: bestMatch.display_name,
                    shopee_user_id: bestMatch.shopee_user_id,
                    promote_category_ids: bestMatch.promote_category_ids || [], 
                    details: null 
                };

                console.log(`   🔗 Membuka halaman detail untuk menyadap analitik mendalam...`);
                
                const detailResponseInterceptor = async (response) => {
                    const url = response.url();
                    if (url.includes('/api/v3/affiliateplatform/creator/detail')) {
                        try {
                            const json = await response.json();
                            if (json && json.code === 0 && json.data) {
                                console.log(`   📥 Berhasil menyadap JSON dari: /creator/detail`);
                                finalData.details = json.data;
                            }
                        } catch(e) {}
                    }
                };

                page.on('response', detailResponseInterceptor);

                const detailUrl = `https://seller.shopee.co.id/portal/web-seller-affiliate/kol_marketplace/detail?affiliate_id=${finalData.affiliate_id}`;
                await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                
                await sleep(5000); 
                page.off('response', detailResponseInterceptor);

                // --- 4. PEMETAAN (MAPPING) DATA UNTUK SPREADSHEET (Kolom A s/d P) ---
                if (finalData.details) {
                    const d = finalData.details;
                    const metrics = d.sales_metrics || {};
                    
                    let categoryText = finalData.promote_category_ids
                        .map(id => categoryMap[id] || id)
                        .join(', ');

                    let priaRatio = 0, wanitaRatio = 0;
                    if (d.audience_genders && Array.isArray(d.audience_genders)) {
                        const m = d.audience_genders.find(g => g.gender_type === 1);
                        const f = d.audience_genders.find(g => g.gender_type === 2);
                        if (m) priaRatio = m.gender_ratio;
                        if (f) wanitaRatio = f.gender_ratio;
                    }

                    let ageType = "", ageRatio = 0;
                    const ageArr = d.audience_ages || (d.profile && d.profile.audience_age ? [d.profile.audience_age] : []);
                    if (ageArr && ageArr.length > 0) {
                        ageArr.sort((a, b) => b.age_ratio - a.age_ratio);
                        const topAge = ageArr[0];
                        
                        let idx = topAge.age_range_type - 1;
                        if (idx < 0 || idx >= ages_range.length) idx = topAge.age_range_type;
                        
                        ageType = ages_range[idx] || `Type-${topAge.age_range_type}`;
                        ageRatio = topAge.age_ratio;
                    }

                    // Ekstraksi Kontak Telepon dan Email
                    let phoneStr = "";
                    let emailStr = "";
                    if (d.contact_info) {
                        phoneStr = d.contact_info.phone || "";
                        emailStr = d.contact_info.email || "";
                    }

                    // ARRAY 13 KOLOM (A - M)
                    let rowData = new Array(13).fill('');
                    rowData[0] = new Date().toLocaleString('id-ID'); // A: Update Time
                    rowData[1] = targetName;                         // B: Username/Name
                    rowData[2] = categoryText;                       // C: Category By Shopee
                    rowData[3] = finalData.affiliate_id;             // D: Affiliate ID
                    
                    rowData[4] = metrics.sold_range ? metrics.sold_range.join(' - ') : "0 - 0"; // E
                    
                    rowData[5] = metrics.orders_range ? metrics.orders_range.join(' - ') : "0 - 0"; // F
                    
                    rowData[6] = metrics.gmv_range ? metrics.gmv_range.map((n)=>Math.round(n * 0.00001)).join(' - ') : "0 - 0"; //G
                    
                    rowData[7] = priaRatio;                         // H: Pria (Ratio)
                    rowData[8] = wanitaRatio;                       // I: Wanita (Ratio)
                    rowData[9] = ageType;                           // J: Usia (Type String)
                    rowData[10] = ageRatio;                          // K: Usia (Ratio)

                    rowData[11] = phoneStr;                          // L: Phone
                    rowData[12] = emailStr;                          // M: Email

                    // 5. SIMPAN KE SPREADSHEET
                    await saveToTargetSheet(rowData, existingRowNumber);
                    
                    if (isNew) {
                        existingDataMap.set(targetName.toLowerCase(), {
                            rowNumber: 99999,
                            lastUpdate: rowData[0]
                        });
                    }

                    // 6. SIMPAN KE SQLITE DATABASE LOKAL
                    try {
                        await saveAffiliateToDB(finalData.affiliate_id, finalData);
                        console.log(`   💾 Tersimpan ke SQLite Database`);
                    } catch (dbErr) {
                        console.log(`   ❌ Gagal menyimpan ke SQLite: ${dbErr.message}`);
                    }

                } else {
                    console.log(`   ⚠️ Halaman detail terbuka, namun request detail tidak tertangkap.`);
                }

            } catch (err) {
                console.error(`❌ Error sistem saat memproses ${targetName}:`, err.message);
            }

            await sleep(3000 + Math.random() * 2000);
        }

        console.log("\n🏁 Pengumpulan Data Shopee Selesai.");
        browser.disconnect();

    } catch (error) {
        console.error("Critical Error:", error);
    }
}

runShopeeBot();