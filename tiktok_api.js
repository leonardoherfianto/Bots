require('dotenv').config();
const { google } = require('googleapis');
const puppeteer = require('puppeteer-core');
const cheerio = require('cheerio');

const DEBUG_PORT = 9222;

// --- CONFIG GOOGLE SHEETS ---
const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SOURCE_SHEET = '01 Listing';
const TARGET_SHEET = '02 Analysis Tiktok';

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

function getKolTier(followersCount) {
    if (!followersCount || followersCount < 1) return "";
    
    if (followersCount <= 10000) return "Nano";
    if (followersCount <= 50000) return "Mikro 1";
    if (followersCount <= 100000) return "Mikro 2";
    if (followersCount <= 500000) return "MID-Tier";
    if (followersCount <= 1000000) return "Macro";
    return "Mega"; // > 1.000.000
}

// Helper: Format UNIX timestamp TikTok
function formatCreateTime(unixSeconds) {
    if (!unixSeconds) return "";
    const dateObj = new Date(unixSeconds * 1000);
    return dateObj.toLocaleDateString('id-ID') + ' ' + dateObj.toLocaleTimeString('id-ID');
}

// --- FUNGSI SPREADSHEET ---
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
        const category = row[3]; 
        const ttLink = row[13] || ""; 
        if (name && ttLink !== "" && ttLink.includes('tiktok.com')) {
            targets.push({ name, category, ttLink });
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
            range: `${TARGET_SHEET}!A${existingRowNumber}:BN${existingRowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   🔄 Data diperbarui pada baris ${existingRowNumber}`);
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A:BN`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   ➕ Data ditambahkan sebagai baris baru`);
    }
}

// --- FASE 1: AUTO HARVESTER (PEMANEN TOKEN) ---
async function harvestTiktokTokens(page, sampleUrl) {
    return new Promise(async (resolve) => {
        console.log(`\n🕵️‍♂️ [AUTO-HARVEST] Membuka profil pancingan untuk menangkap URI & Cookie...`);
        console.log(`🔗 URL Pancingan: ${sampleUrl}`);
        
        let tokensFound = false;
        let capturedData = null;

        const requestInterceptor = (request) => {
            const url = request.url();
            
            // ATURAN KETAT: Harus item_list DAN memiliki secUid
            if (url.includes('/api/post/item_list/') && url.includes('secUid=')) {
                const headers = request.headers();
                const cookie = headers['cookie'] || headers['Cookie'];
                
                if (cookie && !tokensFound) {
                    console.log("🎯 [BINGO] Request item_list dengan secUid berhasil ditangkap!");
                    tokensFound = true;
                    capturedData = { rawURI: url, rawCookie: cookie };
                }
            }
        };

        page.on('request', requestInterceptor);

        try {
            await page.bringToFront();
            await page.goto(sampleUrl, { waitUntil: 'domcontentloaded' });
            await sleep(4000); 
            
            console.log("📜 Scrolling untuk memancing request jaringan TikTok...");
            await page.evaluate(() => window.scrollBy(0, 1000));
            await sleep(6000); 
            
            page.off('request', requestInterceptor);

            if (tokensFound && capturedData) {
                resolve(capturedData);
            } else {
                console.log("⚠️ Gagal menangkap request. (Mungkin internet lambat atau TikTok mengubah API).");
                resolve(null);
            }
        } catch (err) {
            page.off('request', requestInterceptor);
            resolve(null);
        }
    });
}

// --- MAIN BOT LOGIC ---
async function runTiktokBot() {
    try {
        console.log("📥 [TikTok] Mengambil daftar target dari Spreadsheet...");
        let dataset = await getTargetsFromSheet();
        if (dataset.length === 0) return console.log("⚠️ Tidak ada target TikTok ditemukan.");
        console.log(`✅ Ditemukan ${dataset.length} target TikTok.`);
        
        console.log("🔍 Mengecek histori data di Target Sheet TikTok...");
        const existingDataMap = await getExistingDataMap();

        // 1 MINGGU DALAM MILIDETIK (7 Hari * 24 Jam * 60 Menit * 60 Detik * 1000)
        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const nowMs = Date.now();

        // --- FASE 1: PEMETAAN & EVALUASI WAKTU UPDATE ---
        for (let item of dataset) {
            const existingData = existingDataMap.get(item.name.trim().toLowerCase());
            
            if (existingData) {
                item.lastUpdateMs = parseIdDate(existingData.lastUpdate);
                item.existingRowNumber = existingData.rowNumber;
                item.isNew = false;
            } else {
                item.lastUpdateMs = 0; // Priority: 0 agar urutan pertama disortir
                item.existingRowNumber = -1;
                item.isNew = true;
            }
        }

        // --- FASE 2: PENGURUTAN (SORTING) ---
        // Urutkan dari data terbaru yang belum diupdate / kosong (0) ke data terupdate.
        dataset.sort((a, b) => a.lastUpdateMs - b.lastUpdateMs);

        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        // ====================================================================
        // EKSEKUSI HARVESTER DI AWAL
        // ====================================================================
        const pancinganUrl = "https://www.tiktok.com/@juanrichd"; 
        const tokens = await harvestTiktokTokens(page, pancinganUrl);

        if (!tokens) {
            console.log("❌ Auto-Harvest gagal. Hentikan operasi TikTok.");
            browser.disconnect();
            return;
        }

        const dynamicRawURI = tokens.rawURI;
        const dynamicRawCookie = tokens.rawCookie;
        console.log("✅ Token & URI Dinamis berhasil diamankan untuk sesi ini.");
        // ====================================================================

        let processCounter = 0;

        for (let item of dataset) {
            processCounter++;
            const { name, category, ttLink, lastUpdateMs, existingRowNumber, isNew } = item;

            // CEK COOLDOWN 1 MINGGU UNTUK DATA LAMA
            if (!isNew && (nowMs - lastUpdateMs) < ONE_WEEK_MS) {
                console.log(`\n[${processCounter}/${dataset.length}] ⏭️ Melewati ${name} (Data diperbarui kurang dari 1 minggu yang lalu)`);
                continue; 
            }

            if (isNew) {
                console.log(`\n[${processCounter}/${dataset.length}] ➕ Target Baru Ditemukan: ${name}`);
            } else {
                console.log(`\n[${processCounter}/${dataset.length}] 🔄 Memperbarui Data Lama: ${name}`);
            }

            try {
                await page.bringToFront();
                
                // LANGKAH 1: Ambil HTML Mentah via Fetch
                const htmlContent = await page.evaluate(async (url) => {
                    try {
                        const response = await fetch(url);
                        if (!response.ok) return null;
                        return await response.text();
                    } catch (e) { return null; }
                }, ttLink);

                if (!htmlContent) {
                    console.log("   ❌ Gagal fetch HTML profil.");
                    await sleep(3000);
                    continue;
                }

                // LANGKAH 2: Ekstrak secUid dengan Cheerio
                let secUid = null;
                const $ = cheerio.load(htmlContent);

                $('script').each((i, el) => {
                    const contentScript = $(el).html() || "";
                    if (contentScript.includes('secUid')) {
                        const start = contentScript.indexOf('{');
                        const end = contentScript.lastIndexOf('}');
                        if (start !== -1 && end !== -1 && start < end) {
                            try {
                                const jsonString = contentScript.substring(start, end + 1);
                                const jdata = JSON.parse(jsonString);
                                if (jdata["__DEFAULT_SCOPE__"] && 
                                    jdata["__DEFAULT_SCOPE__"]["webapp.user-detail"] && 
                                    jdata["__DEFAULT_SCOPE__"]["webapp.user-detail"]["userInfo"]) {
                                    
                                    const userInfo = jdata["__DEFAULT_SCOPE__"]["webapp.user-detail"]["userInfo"];
                                    if (userInfo && userInfo.user) {
                                        secUid = userInfo.user.secUid;
                                        return false; // Break loop
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                });

                if (!secUid) {
                    console.log(`   ❌ secUid tidak ditemukan di HTML. Skip.`);
                    await sleep(3000);
                    continue;
                }

                // LANGKAH 3: Fetch Data via API menggunakan Token Hasil Harvest
                const metadata = await page.evaluate(async (uri, cookie, validSecUid) => {
                    const finalURI = uri.replace(/secUid=[^&]*/, `secUid=${validSecUid}`);
                    try {
                        const response = await fetch(finalURI, {
                            headers: { "accept": "*/*", "cookie": cookie },
                            method: "GET"
                        });
                        const res = await response.json();
                        if (!res.itemList || res.itemList.length === 0) return null;

                        const stats = res.itemList[0].authorStats || {};
                        return {
                            followerCount: stats.followerCount || 0,
                            contents: res.itemList.slice(0, 9).map(v => ({
                                playCount: v.stats?.playCount,
                                diggCount: v.stats?.diggCount,
                                commentCount: v.stats?.commentCount,
                                shareCount: v.stats?.shareCount,
                                collectCount: v.stats?.collectCount,
                                createTime: v.createTime
                            }))
                        };
                    } catch (e) { return null; }
                }, dynamicRawURI, dynamicRawCookie, secUid);

                if (!metadata) {
                    console.log("   ❌ Gagal mengambil data ItemList via API.");
                    continue;
                }

                // LANGKAH 4: Menyusun Data Spreadsheet
                let rowData = new Array(66).fill(''); 
                
                rowData[0] = new Date().toLocaleString('id-ID'); // A: Timestamp
                rowData[1] = name;         // B: Name
                rowData[2] = category;     // C: Category
                rowData[3] = ttLink;       // D: Link
                rowData[4] = metadata.followerCount; // E: Followers
                rowData[5] = getKolTier(rowData[4]);

                let colIndex = 6; 
                let viewsArr = [];
                let enggArr = [];

                for (let i = 0; i < 9; i++) {
                    if (metadata.contents[i]) {
                        const post = metadata.contents[i];
                        rowData[colIndex]     = post.playCount || 0;
                        rowData[colIndex + 1] = post.diggCount || 0;
                        rowData[colIndex + 2] = post.commentCount || 0;
                        rowData[colIndex + 3] = post.collectCount || 0;
                        rowData[colIndex + 4] = post.shareCount || 0;
                        rowData[colIndex + 5] = formatCreateTime(post.createTime);
                    } else {
                        rowData[colIndex]     = 0;
                        rowData[colIndex + 1] = 0;
                        rowData[colIndex + 2] = 0;
                        rowData[colIndex + 3] = 0;
                        rowData[colIndex + 4] = 0;
                        rowData[colIndex + 5] = "";
                    }
                    viewsArr.push(rowData[colIndex]);
                    enggArr.push(rowData[colIndex + 1] + rowData[colIndex + 2]);
                    colIndex += 6;
                }

                let sumviews = viewsArr.reduce((t, n)=> (t + n), 0);
                let medviews = viewsArr.sort((a, b) => a - b)[4] || 0;

                let sumengg = enggArr.reduce((t, n)=> (t + n), 0);
                let medengg = enggArr.sort((a, b) => a - b)[4] || 0;

                rowData[60] = sumviews;
                rowData[61] = sumviews / 9;
                rowData[62] = medviews;

                rowData[63] = sumengg;
                rowData[64] = sumengg / 9;
                rowData[65] = medengg;

                // 5. SIMPAN KE SPREADSHEET
                await saveToTargetSheet(rowData, existingRowNumber);
                
                if (isNew) {
                    existingDataMap.set(name.trim().toLowerCase(), {
                        rowNumber: 99999,
                        lastUpdate: rowData[0]
                    });
                }

            } catch (err) {
                console.error(`   ❌ Error processing ${name}:`, err.message);
            }

            await sleep(3000 + Math.random() * 2000);
        }

        console.log("\n🏁 Semua target TikTok selesai diproses.");
        browser.disconnect();

    } catch (error) {
        console.error("Critical Error:", error);
    }
}

runTiktokBot();