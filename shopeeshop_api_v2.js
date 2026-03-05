require('dotenv').config();
const { google } = require('googleapis');
const puppeteer = require('puppeteer-core');

const DEBUG_PORT = 9222;

// --- CONFIG GOOGLE SHEETS ---
const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SOURCE_SHEET = '01 Listing';
const TARGET_SHEET = '02 Analysis Shopee MVP'; // Anda bisa mengubah nama sheet target ini

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

// --- ALGORITMA KEMIRIPAN STRING ---
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
        range: `${SOURCE_SHEET}!A3:Z`, 
    });
    
    const rows = response.data.values || [];
    if (rows.length < 2) return [];

    const headers = rows[0]; 
    const dataRows = rows.slice(1); 
    
    let shopeeAffiliateIdx = headers.findIndex(h => h && h.toLowerCase().includes('shopee affiliate'));

    const targets = [];
    dataRows.forEach((row) => {
        const listingName = row[2]; // C: Username/Name
        let shopeeAffiliateName = null;
        
        if (shopeeAffiliateIdx !== -1) {
            shopeeAffiliateName = row[shopeeAffiliateIdx];
        }
        
        const targetName = shopeeAffiliateName && shopeeAffiliateName.trim() !== "" 
                            ? shopeeAffiliateName.trim() 
                            : (listingName ? listingName.trim() : null);

        if (listingName && targetName && targetName !== "") {
            targets.push({ 
                originalName: listingName.trim(), 
                targetName: targetName 
            });
        }
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
            range: `${TARGET_SHEET}!A${existingRowNumber}:AD${existingRowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   🔄 Data Local Shopee diperbarui pada baris ${existingRowNumber}`);
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A:AD`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   ➕ Data Local Shopee ditambahkan sebagai baris baru`);
    }
}

// --- FASE 1: AUTO HARVESTER SHOPEE (V2) ---
async function harvestShopeeHeadersV2(page) {
    return new Promise(async (resolve) => {
        console.log(`\n🕵️‍♂️ [AUTO-HARVEST] Membuka Shopee Affiliate Analytics untuk memanen headers v2...`);
        let headersFound = false;
        let capturedHeaders = null;

        const requestInterceptor = (request) => {
            const url = request.url();
            // PERUBAHAN: Menangkap header dari area affiliate_analytics
            if (url.includes('/api/v3/affiliateplatform/dashboard/') || url.includes('/api/v1/affiliateplatform/')) {
                const headers = request.headers();
                if (headers['x-sap-sec'] && !headersFound) {
                    console.log("🎯 [BINGO] Headers keamanan Shopee Analytics berhasil ditangkap!");
                    headersFound = true;
                    capturedHeaders = {
                        "accept": headers['accept'] || "application/json, text/plain, */*",
                        "af-ac-enc-dat": headers['af-ac-enc-dat'],
                        "af-ac-enc-sz-token": headers['af-ac-enc-sz-token'],
                        "content-type": headers['content-type'] || "application/json; charset=UTF-8",
                        "x-sap-ri": headers['x-sap-ri'],
                        "x-sap-sec": headers['x-sap-sec'],
                        "x-sz-sdk-version": headers['x-sz-sdk-version'] || "1.12.25-sc.3",
                        "cookie": headers['cookie'] || headers['Cookie']
                    };
                }
            }
        };

        page.on('request', requestInterceptor);
        try {
            await page.bringToFront();
            // PERUBAHAN: URL pancingan diarahkan ke Affiliate Analytics
            await page.goto('https://seller.shopee.co.id/portal/web-seller-affiliate/affiliate_analytics', { waitUntil: 'networkidle2', timeout: 60000 });
            await sleep(6000); 
            
            // Lakukan sedikit interaksi/scroll untuk memancing API call
            await page.evaluate(() => window.scrollBy(0, 500));
            await sleep(3000);

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
async function runShopeeBotV2() {
    try {
        console.log("📥 [Shopee V2] Mengambil daftar target dari Spreadsheet...");
        let dataset = await getTargetsFromSheet();

        if (dataset.length === 0) return console.log("⚠️ Tidak ada target ditemukan.");
        
        console.log("🔍 Mengecek histori data di Target Sheet...");
        const existingDataMap = await getExistingDataMap();

        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const nowMs = Date.now();

        // Pemetaan Waktu dan Sorting
        for (let item of dataset) {
            const existingData = existingDataMap.get(item.originalName.toLowerCase());
            if (existingData) {
                item.lastUpdateMs = parseIdDate(existingData.lastUpdate);
                item.existingRowNumber = existingData.rowNumber;
                item.isNew = false;
            } else {
                item.lastUpdateMs = 0; 
                item.existingRowNumber = -1;
                item.isNew = true;
            }
        }
        dataset.sort((a, b) => a.lastUpdateMs - b.lastUpdateMs);

        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        // HARVEST HEADER
        const dynamicHeaders = await harvestShopeeHeadersV2(page);
        if (!dynamicHeaders) {
            console.log("❌ Auto-Harvest gagal. Hentikan operasi Shopee V2.");
            browser.disconnect(); return;
        }

        // Tentukan Range Waktu Pencarian (contoh: 30 hari terakhir)
        // Kita butuh timestamp Unix dalam Detik
        const end_time = Math.floor(Date.now() / 1000);
        const start_time = end_time - (30 * 24 * 60 * 60);

        let processCounter = 0;

        for (let item of dataset) {
            processCounter++;
            const { originalName, targetName, lastUpdateMs, existingRowNumber, isNew } = item;

            if (!isNew && (nowMs - lastUpdateMs) < ONE_WEEK_MS) {
                console.log(`\n[${processCounter}/${dataset.length}] ⏭️ Melewati ${originalName} (Data baru saja diperbarui)`);
                continue; 
            }

            console.log(`\n[${processCounter}/${dataset.length}] ${isNew ? '➕' : '🔄'} Mencari: ${targetName} (Untuk: ${originalName})`);

            try {
                await page.bringToFront();

                // 1. QUERY SEARCH NAME (Mendapatkan Affiliate ID)
                const searchResponse = await page.evaluate(async (affName, headersObj) => {
                    try {
                        const payload = { "affiliate_name": affName };
                        const response = await fetch("https://seller.shopee.co.id/api/v1/affiliateplatform/affiliate/search_affiliatename_hint", {
                            headers: headersObj, 
                            body: JSON.stringify(payload), 
                            method: "POST"
                        });
                        return await response.json();
                    } catch (e) { return { error: e.message }; }
                }, targetName, dynamicHeaders);

                if (searchResponse.error || searchResponse.code !== 0) {
                    console.log(`   ❌ Gagal Search Name: ${searchResponse.error || searchResponse.msg}`);
                    continue;
                }

                const dataList = searchResponse.data?.list || [];
                if (dataList.length === 0) {
                    console.log(`   ℹ️ User '${targetName}' tidak ditemukan di hint search.`);
                    continue;
                }

                // 2. CARI KECOCOKAN NAMA TERBAIK
                let bestMatch = null;
                let highestMatchScore = -1;

                dataList.forEach(resultItem => {
                    let score = calculateSimilarity(targetName, resultItem.affiliate_name);
                    if (score > highestMatchScore) {
                        highestMatchScore = score;
                        bestMatch = resultItem;
                    }
                });

                if (!bestMatch || !bestMatch.affiliate_id) {
                    console.log(`   ❌ Tidak ada affiliate_id yang valid.`);
                    continue;
                }

                console.log(`   🎯 Match Terbaik: ${bestMatch.affiliate_name} (ID: ${bestMatch.affiliate_id}) - Akurasi: ${highestMatchScore.toFixed(2)}%`);

                // 3. FETCH METRIK PERFORMA
                const metricsResponse = await page.evaluate(async (affId, startTime, endTime, headersObj) => {
                    try {
                        // Hilangkan content-type json karena ini GET request
                        const getHeaders = { ...headersObj };
                        delete getHeaders['content-type'];

                        const url = `https://seller.shopee.co.id/api/v3/affiliateplatform/dashboard/affiliate_performance?start_time=${startTime}&end_time=${endTime}&affiliate_id=${affId}&page_num=1&page_size=20&sort_rule=3&period_type=1&order_type=2&channel=0&has_meta_feature=1`;
                        
                        const response = await fetch(url, {
                            headers: getHeaders,
                            method: "GET"
                        });
                        return await response.json();
                    } catch (e) { return { error: e.message }; }
                }, bestMatch.affiliate_id, start_time, end_time, dynamicHeaders);

                if (metricsResponse.error || metricsResponse.code !== 0) {
                    console.log(`   ❌ Gagal Fetch Metrik: ${metricsResponse.error || metricsResponse.msg}`);
                    continue;
                }

                const metricsData = metricsResponse.data?.list ? metricsResponse.data.list[0] : null;

                if (!metricsData) {
                    console.log(`   ⚠️ Tidak ada data performa transaksi yang tercatat untuk affiliator ini dalam 30 hari terakhir.`);
                    // Lanjutkan dengan nilai nol
                } else {
                    console.log(`   ✅ Berhasil menarik metrik performa: ${metricsData.dis_orders} Orders | GMV: ${metricsData.dis_gmv}`);
                }

                let rowData = new Array(30).fill('');
                
                rowData[0] = new Date().toLocaleString('id-ID'); // A: Update Time
                rowData[1] = originalName;                       // B: Listing Name (Dari Sheet 01)
                
                if (metricsData) {
                    rowData[2] = metricsData.affiliate_id || "";
                    rowData[3] = metricsData.user_id || "";
                    rowData[4] = metricsData.shopee_username || "";
                    rowData[5] = metricsData.display_name || "";
                    rowData[6] = metricsData.avatar || "";
                    
                    rowData[7] = metricsData.clicks || 0;
                    rowData[8] = metricsData.dis_clicks || "0";
                    
                    rowData[9] = metricsData.orders || 0;
                    rowData[10] = metricsData.dis_orders || "0";
                    rowData[11] = metricsData.item_sold || 0;
                    
                    rowData[12] = metricsData.gmv || 0;
                    rowData[13] = metricsData.dis_gmv || "0";
                    
                    rowData[14] = metricsData.est_commission || 0;
                    rowData[15] = metricsData.dis_est_commission || "0";
                    rowData[16] = metricsData.actual_commission || 0;
                    
                    rowData[17] = metricsData.conversion_rate || 0;
                    rowData[18] = metricsData.dis_conversion_rate || "0.00%";
                    
                    rowData[19] = metricsData.roi || 0;
                    rowData[20] = metricsData.dis_roi || "0";
                    
                    rowData[21] = metricsData.total_buyers || 0;
                    rowData[22] = metricsData.new_buyers || 0;
                    
                    rowData[23] = metricsData.is_affiliate_network ?? "";
                    rowData[24] = metricsData.is_creator_marketplace ?? "";
                    rowData[25] = metricsData.is_free_sample ?? "";
                    rowData[26] = metricsData.is_ppp_kol ?? "";
                    rowData[27] = metricsData.is_specific_kol ?? "";
                    
                    // Untuk array, kita gabungkan menjadi string dipisah koma
                    rowData[28] = metricsData.top_category_ids ? metricsData.top_category_ids.join(", ") : "";
                    rowData[29] = metricsData.content_info ? JSON.stringify(metricsData.content_info) : "[]";
                } else {
                    // Jika belum ada metrik penjualan, isi ID dan nama sisanya 0/kosong
                    rowData[2] = bestMatch.affiliate_id || "";
                    rowData[5] = bestMatch.affiliate_name || "";
                    for(let i=7; i<=22; i++) rowData[i] = 0;
                }

                // 5. SIMPAN KE SPREADSHEET
                await saveToTargetSheet(rowData, existingRowNumber);
                
                if (isNew) {
                    existingDataMap.set(originalName.toLowerCase(), {
                        rowNumber: 99999,
                        lastUpdate: rowData[0]
                    });
                }

            } catch (err) {
                console.error(`   ❌ Error sistem saat memproses ${targetName}:`, err.message);
            }

            await sleep(4000 + Math.random() * 2000); // Jeda Anti-Bot
        }

        console.log("\n🏁 Pengumpulan Data Performa Shopee (Local) Selesai.");
        browser.disconnect();

    } catch (error) {
        console.error("Critical Error:", error);
    }
}

runShopeeBotV2();