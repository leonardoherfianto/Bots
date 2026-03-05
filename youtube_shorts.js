require('dotenv').config();
const { google } = require('googleapis');
const puppeteer = require('puppeteer-core');
const axios = require('axios');

const DEBUG_PORT = 9222;

// --- CONFIG GOOGLE SHEETS ---
const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SOURCE_SHEET = '01 Listing';
const TARGET_SHEET = '02 Analysis Youtube Shorts'; // Sheet tujuan untuk Shorts

// --- CONFIG YOUTUBE API ---
const BASE_URL = 'https://www.googleapis.com/youtube/v3/';
const API_KEYS = [
    'AIzaSyALhFT3BKazNilIOtYrxosO2urcbD1Ea3Y', 
    'AIzaSyBu4SI5QUUdO7bd-FlnNe7ct5jDpCC9Ku8'
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getKolTier(followersCount) {
    if (!followersCount || followersCount < 1) return "";
    
    if (followersCount <= 10000) return "Nano";
    if (followersCount <= 50000) return "Mikro 1";
    if (followersCount <= 100000) return "Mikro 2";
    if (followersCount <= 500000) return "MID-Tier";
    if (followersCount <= 1000000) return "Macro";
    return "Mega"; // > 1.000.000
}

function getApiKey() {
    return API_KEYS[Math.floor(Math.random() * API_KEYS.length)];
}

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

// Helper: Fetch API Statistik Channel
async function getChannelStatsAPI(channelId) {
    try {
        const apiKey = getApiKey();
        const url = `${BASE_URL}channels?part=statistics&id=${channelId}&key=${apiKey}`;
        const res = await axios.get(url);
        if (res.data.items && res.data.items.length > 0) {
            const stats = res.data.items[0].statistics;
            return {
                subscribers: parseInt(stats.subscriberCount || 0, 10),
            };
        }
    } catch (e) { console.error("API Channel Error:", e.message); }
    return { subscribers: 0 };
}

// Helper: Fetch API Statistik Video (Shorts menggunakan API Video yang sama)
async function getVideosStatsAPI(videoIds) {
    if (!videoIds || videoIds.length === 0) return [];
    try {
        const apiKey = getApiKey();
        const ids = videoIds.join(',');
        const url = `${BASE_URL}videos?part=snippet,statistics&id=${ids}&key=${apiKey}`;
        const res = await axios.get(url);
        
        if (res.data.items) {
            return res.data.items.map(item => {
                const dateObj = new Date(item.snippet.publishedAt);
                const formattedDate = dateObj.toLocaleDateString('id-ID') + ' ' + dateObj.toLocaleTimeString('id-ID');

                return {
                    id: item.id,
                    views: parseInt(item.statistics.viewCount || 0, 10),
                    likes: parseInt(item.statistics.likeCount || 0, 10),
                    comments: parseInt(item.statistics.commentCount || 0, 10),
                    publishedAt: formattedDate
                };
            });
        }
    } catch (e) { console.error("API Video Error:", e.message); }
    return [];
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
        const name = row[2];     // C: Username/Name
        const category = row[3]; // D: Category
        const ytLink = row[9] || ""; // J: Link Youtube

        if (name && ytLink !== "") {
            const isYouTubeUrl = ytLink.includes('youtube.com') || ytLink.includes('youtu.be');
            if (isYouTubeUrl) {
                targets.push({ name, category, ytLink });
            }
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
            const updateTime = row[0]; // Kolom A
            const username = row[1];   // Kolom B
            
            if (username) {
                map.set(username.trim().toLowerCase(), {
                    rowNumber: index + 1,
                    lastUpdate: updateTime || ''
                });
            }
        });
        
        return map;
    } catch (e) {
        console.log("Catatan: Sheet Target Shorts kosong / belum bisa dibaca.");
        return new Map();
    }
}

async function saveToTargetSheet(rowData, existingRowNumber = null) {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    if (existingRowNumber && existingRowNumber !== -1) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A${existingRowNumber}:AV${existingRowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   🔄 Data Shorts diperbarui pada baris ${existingRowNumber}`);
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A:AV`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   ➕ Data Shorts ditambahkan sebagai baris baru`);
    }
}

// --- MAIN BOT LOGIC ---
async function runYouTubeShortsBot() {
    try {
        console.log("📥 [YT Shorts] Mengambil daftar target dari Spreadsheet '01 Listing'...");
        let dataset = await getTargetsFromSheet();

        if (dataset.length === 0) return console.log("⚠️ Tidak ada target YouTube ditemukan.");
        console.log(`✅ Ditemukan ${dataset.length} target YouTube.`);

        console.log("🔍 Mengecek histori data di Target Sheet Shorts...");
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
                item.lastUpdateMs = 0; // Set ke 0 agar jadi prioritas utama saat disortir
                item.existingRowNumber = -1;
                item.isNew = true;
            }
        }

        // --- FASE 2: PENGURUTAN (SORTING) ---
        // Urutkan dari yang paling lama tidak diupdate ke yang terbaru
        dataset.sort((a, b) => a.lastUpdateMs - b.lastUpdateMs);

        console.log("🌐 Menyiapkan environment YouTube Shorts...");
        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        let processCounter = 0;

        // --- FASE 3: EKSEKUSI SCRAPING ---
        for (let item of dataset) {
            processCounter++;
            const { name, category, ytLink, lastUpdateMs, existingRowNumber, isNew } = item;

            // CEK COOLDOWN 1 MINGGU UNTUK DATA LAMA
            if (!isNew && (nowMs - lastUpdateMs) < ONE_WEEK_MS) {
                console.log(`[${processCounter}/${dataset.length}] ⏭️ Melewati ${name} (Data diperbarui kurang dari 1 minggu yang lalu)`);
                continue; 
            }

            if (isNew) {
                console.log(`\n[${processCounter}/${dataset.length}] ➕ Target Baru Ditemukan: ${name}`);
            } else {
                console.log(`\n[${processCounter}/${dataset.length}] 🔄 Memperbarui Data Lama: ${name}`);
            }

            try {
                // 1. NAVIGASI KE TAB SHORTS
                await page.bringToFront();
                let targetUrl = ytLink;
                // Bersihkan URL dari path lain dan tambahkan /shorts
                targetUrl = targetUrl.replace(/\/videos\/?$/, '').replace(/\/$/, '') + '/shorts';

                await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
                await sleep(3000); // Tunggu render JS

                // 2. SCRAPE CHANNEL ID & 9 VIDEO IDs SHORTS TERBARU
                const scrapeResult = await page.evaluate(() => {
                    try {
                        let ytData = window['ytInitialData'];
                        if (!ytData) return null;

                        const meta = ytData.metadata?.channelMetadataRenderer;
                        const channelId = meta?.externalId;
                        if (!channelId) return null;

                        let videoIds = [];
                        const tabs = ytData.contents?.twoColumnBrowseResultsRenderer?.tabs;
                        // Cari tab dengan judul Shorts
                        const shortsTab = tabs?.find(t => t.tabRenderer?.title === 'Shorts');
                        
                        if (shortsTab) {
                            const contents = shortsTab.tabRenderer.content?.richGridRenderer?.contents;
                            if (contents) {
                                contents.forEach(c => {
                                    const richItem = c.richItemRenderer?.content;
                                    
                                    // Deteksi Format Baru YouTube Shorts
                                    const reelId = richItem?.shortsLockupViewModel?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
                                    // Deteksi Format Lama YouTube Shorts
                                    const legacyId = richItem?.reelItemRenderer?.videoId;
                                    
                                    if (reelId) {
                                        videoIds.push(reelId);
                                    } else if (legacyId) {
                                        videoIds.push(legacyId);
                                    }
                                });
                            }
                        }
                        return { channelId, videoIds: videoIds.slice(0, 9) };
                    } catch (e) { return null; }
                });

                if (!scrapeResult || !scrapeResult.channelId) {
                    console.log("   ❌ Gagal scraping ID Shorts dari halaman. (Mungkin channel tidak punya Shorts)");
                    continue;
                }

                if (scrapeResult.videoIds.length === 0) {
                    console.log("   ⚠️ Channel ini tidak memiliki video Shorts satupun.");
                }

                // 3. FETCH DETAILS VIA API
                const channelStats = await getChannelStatsAPI(scrapeResult.channelId);
                const videoDetails = await getVideosStatsAPI(scrapeResult.videoIds);

                // 4. SUSUN DATA MAPPING
                let rowData = new Array(48).fill(''); 
                
                rowData[0] = new Date().toLocaleString('id-ID'); // A: Timestamp
                rowData[1] = name;         // B: Name
                rowData[2] = category;     // C: Category
                rowData[3] = ytLink;       // D: Link
                rowData[4] = channelStats.subscribers; // E: Subs
                rowData[5] = getKolTier(rowData[4]);

                // Mulai dari Index 6 (Kolom G)
                let colIndex = 6;
                let viewsArr = [];
                let enggArr = [];

                for (let i = 0; i < 9; i++) {
                    if (videoDetails[i]) {
                        rowData[colIndex] = videoDetails[i].views;      // V
                        rowData[colIndex + 1] = videoDetails[i].comments; // C
                        rowData[colIndex + 2] = videoDetails[i].likes;    // L
                        rowData[colIndex + 3] = videoDetails[i].publishedAt; // T
                    } else {
                        rowData[colIndex] = 0;
                        rowData[colIndex + 1] = 0;
                        rowData[colIndex + 2] = 0;
                        rowData[colIndex + 3] = "";
                    }
                    viewsArr.push(rowData[colIndex]);
                    enggArr.push(rowData[colIndex + 1] + rowData[colIndex + 2]);
                    colIndex += 4; // Bergeser 4 kolom
                }

                 //insert the formula
                let sumviews = viewsArr.reduce((t, n)=> (t + n), 0);
                let medviews = viewsArr.sort((a, b) => a - b)[4] || 0;

                let sumengg = enggArr.reduce((t, n)=> (t + n), 0);
                let medengg = enggArr.sort((a, b) => a - b)[4] || 0;

                rowData[42] = sumviews;
                rowData[43] = sumviews / 9;
                rowData[44] = medviews;

                rowData[45] = sumengg;
                rowData[46] = sumengg / 9;
                rowData[47] = medengg;

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

        console.log("\n🏁 Semua target Shorts selesai diproses.");
        browser.disconnect();

    } catch (error) {
        console.error("Critical Error:", error);
    }
}

runYouTubeShortsBot();