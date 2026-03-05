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
const TARGET_SHEET = '02 Analysis Instagram';

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

// Helper: Format UNIX timestamp IG (detik) ke Waktu Lokal
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
        const name = row[2];     // C: Username/Name
        const category = row[3]; // D: Category
        const igLink = row[5] || ""; // F: Link IG (Index 5)
        
        if (name && igLink !== "" && igLink.includes('instagram.com')) {
            targets.push({ name, category, igLink });
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
        console.log(`   🔄 Data Instagram diperbarui pada baris ${existingRowNumber}`);
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A:BN`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   ➕ Data Instagram ditambahkan sebagai baris baru`);
    }
}

// --- MAIN BOT LOGIC ---
async function runInstagramBot() {
    try {
        console.log("📥 [Instagram] Mengambil daftar target dari Spreadsheet...");
        let dataset = await getTargetsFromSheet();
        if (dataset.length === 0) return console.log("⚠️ Tidak ada target Instagram ditemukan.");
        
        console.log("🔍 Mengecek histori data di Target Sheet Instagram...");
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
                item.lastUpdateMs = 0; // Set 0 agar jadi urutan pertama saat disortir
                item.existingRowNumber = -1;
                item.isNew = true;
            }
        }

        // --- FASE 2: PENGURUTAN (SORTING) ---
        // Urutkan dari data baru/paling lama belum diupdate ke yang terbaru
        dataset.sort((a, b) => a.lastUpdateMs - b.lastUpdateMs);

        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        let processCounter = 0;

        for (let item of dataset) {
            processCounter++;
            const { name, category, igLink, lastUpdateMs, existingRowNumber, isNew } = item;

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
                // 1. Navigasi ke Halaman Profil
                await page.goto(igLink, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await sleep(3000);

                // 2. SCRAPING MENGGUNAKAN LOGIKA GRAPHQL
                const scrapeData = await page.evaluate(async (targetName, targetLink) => {
                    
                    // --- 0. EKSTRAK USERNAME ASLI DARI URL ---
                    let realUsername = "";
                    try {
                        const urlObj = new URL(targetLink);
                        realUsername = urlObj.pathname.split('/').filter(Boolean)[0];
                    } catch(e) {}
                    if (!realUsername) realUsername = targetName;


                    const getCookie = (name) => {
                        const value = `; ${document.cookie}`;
                        const parts = value.split(`; ${name}=`);
                        if (parts.length === 2) return parts.pop().split(';').shift();
                        return "";
                    };

                    // --- Cari User ID yang lebih aman ---
                    let targetUserId = null;
                    const metaUserId = document.querySelector('meta[property="instapp:owner_user_id"]');
                    if (metaUserId) {
                        targetUserId = metaUserId.getAttribute('content');
                    } else {
                        document.querySelectorAll('script').forEach(s => {
                            if(s.innerText.includes('profile_id')) {
                                const m = s.innerText.match(/"profile_id":"(\d+)"/);
                                if(m && m[1] !== "1" && m[1] !== "0") targetUserId = m[1];
                            }
                        });
                    }

                    if (!targetUserId) return { success: false, error: "Gagal mendapatkan User ID numeric dari HTML." };

                    const viewerId = getCookie('ds_user_id') || "0"; 
                    const commonHeaders = {
                        "accept": "*/*",
                        "x-csrftoken": getCookie('csrftoken'), 
                        "x-ig-app-id": "936619743392459",
                        "x-fb-lsd": "rk5OqXElI2cl_Pp6A-xhvr", 
                        "x-requested-with": "XMLHttpRequest" 
                    };

                    const baseBodyParams = {
                        "av": viewerId, 
                        "__d": "www", "__user": "0", "__a": "1", "__req": "1",
                        "__hs": "20460.HCSV2:instagram_web_pkg.2.1...0", "dpr": "1", 
                        "fb_api_caller_class": "RelayModern", "server_timestamps": "true"
                    };

                    // --- FETCH 1: PROFILE INFO (DENGAN 3 LAPIS FALLBACK) ---
                    let profileData = {};
                    
                    try {
                        const resWeb = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${realUsername}`, {
                            headers: commonHeaders
                        });
                        if (resWeb.ok) {
                            const jsonWeb = await resWeb.json();
                            const userObj = jsonWeb?.data?.user;
                            if (userObj) {
                                profileData.followers = userObj.edge_followed_by?.count || 0;
                                profileData.posts = userObj.edge_owner_to_timeline_media?.count || 0;
                            }
                        }
                    } catch (e) { }

                    if (!profileData.followers) {
                        try {
                            const variablesProfile = JSON.stringify({
                                "enable_integrity_filters": true, "id": targetUserId, "render_surface": "PROFILE"
                            });
                            const bodyProfile = new URLSearchParams({
                                ...baseBodyParams, 
                                "fb_api_req_friendly_name": "PolarisProfilePageContentQuery",
                                "variables": variablesProfile, "doc_id": "25980296051578533" 
                            });
                            const resProfile = await fetch("https://www.instagram.com/graphql/query", {
                                headers: { ...commonHeaders, "x-fb-friendly-name": "PolarisProfilePageContentQuery" },
                                body: bodyProfile, method: "POST"
                            });
                            const jsonProfile = await resProfile.json();
                            const userDict = jsonProfile?.data?.user;
                            if (userDict) {
                                profileData.followers = userDict.follower_count || 0;
                                profileData.posts = userDict.media_count || 0;
                            }
                        } catch (e) { }
                    }

                    if (!profileData.followers) {
                        const metaDesc = document.querySelector('meta[name="description"]');
                        if (metaDesc) {
                            const content = metaDesc.getAttribute('content');
                            const match = content.match(/([\d\.,]+)\s*(m|k|rb|jt)?\s*(Followers|Pengikut)/i);
                            if (match) {
                                let numStr = match[1];
                                let mult = match[2] ? match[2].toLowerCase() : '';
                                
                                if (mult === 'm' || mult === 'jt') {
                                    profileData.followers = Math.floor(parseFloat(numStr.replace(/,/g, '.')) * 1000000);
                                } else if (mult === 'k' || mult === 'rb') {
                                    profileData.followers = Math.floor(parseFloat(numStr.replace(/,/g, '.')) * 1000);
                                } else {
                                    profileData.followers = parseInt(numStr.replace(/[\.,]/g, ''), 10) || 0;
                                }
                            }
                        }
                    }

                    // --- FETCH 2: REELS / POSTS ---
                    let reelsList = [];
                    try {
                        const variablesReels = JSON.stringify({
                            "data": { "include_feed_video": true, "page_size": 12, "target_user_id": targetUserId }
                        });
                        const bodyReels = new URLSearchParams({
                            ...baseBodyParams, "__req": "16",
                            "fb_api_req_friendly_name": "PolarisProfileReelsTabContentQuery",
                            "variables": variablesReels, "doc_id": "24127588873492897"
                        });
                        const resReels = await fetch("https://www.instagram.com/graphql/query", {
                            headers: { ...commonHeaders, "x-fb-friendly-name": "PolarisProfileReelsTabContentQuery" },
                            body: bodyReels, method: "POST"
                        });
                        const jsonReels = await resReels.json();
                        const edges = jsonReels?.data?.xdt_api__v1__clips__user__connection_v2?.edges || [];
                        
                        const limitedEdges = edges.slice(0, 9); 
                        
                        for (let edge of limitedEdges) {
                            const node = edge.node.media;
                            const mediaId = node.id; 
                            let finalTakenAt = 0;
                            let viewCount = node.play_count || 0;
                            let likeCount = node.like_count || 0;
                            let commentCount = node.comment_count || 0;

                            if (mediaId) {
                                try {
                                    const resInfo = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, { method: "GET", headers: commonHeaders });
                                    if (resInfo.ok) {
                                        const jsonInfo = await resInfo.json();
                                        const infoItem = jsonInfo.items ? jsonInfo.items[0] : null;
                                        if (infoItem) {
                                            finalTakenAt = infoItem.taken_at; 
                                            if (infoItem.play_count) viewCount = infoItem.play_count;
                                            if (infoItem.like_count) likeCount = infoItem.like_count;
                                            if (infoItem.comment_count) commentCount = infoItem.comment_count;
                                        }
                                    }
                                } catch (errInfo) { }
                            }
                            if (!finalTakenAt && node.taken_at) finalTakenAt = node.taken_at;

                            reelsList.push({
                                views: viewCount, 
                                likes: likeCount, 
                                comments: commentCount,
                                published_at: finalTakenAt || Math.floor(Date.now() / 1000) 
                            });
                        }
                    } catch (e) { }

                    return {
                        success: true,
                        followers: profileData.followers || 0,
                        posts: profileData.posts || 0,
                        reels: reelsList
                    };

                }, name, igLink);

                if (!scrapeData || !scrapeData.success) {
                    console.log(`   ❌ Gagal Fetch API IG: ${scrapeData?.error}`);
                    continue;
                }

                console.log(`   ✅ Fetch OK! Followers: ${scrapeData.followers.toLocaleString('id-ID')}`);

                // 3. SUSUN DATA MAPPING KE SPREADSHEET
                let rowData = new Array(66).fill(''); 
                
                rowData[0] = new Date().toLocaleString('id-ID'); // A: Timestamp
                rowData[1] = name;         // B: Name
                rowData[2] = category;     // C: Category
                rowData[3] = igLink;       // D: Link IG
                rowData[4] = scrapeData.followers; // E: Followers
                rowData[5] = getKolTier(rowData[4]); // F: Tier

                let colIndex = 6; 
                let viewsArr = [];
                let enggArr = [];

                for (let i = 0; i < 9; i++) {
                    if (scrapeData.reels[i]) {
                        const post = scrapeData.reels[i];
                        rowData[colIndex]     = post.views || 0;       
                        rowData[colIndex + 1] = post.likes || 0;       
                        rowData[colIndex + 2] = post.comments || 0;    
                        rowData[colIndex + 3] = 0;                     
                        rowData[colIndex + 4] = 0;                     
                        rowData[colIndex + 5] = formatCreateTime(post.published_at); 
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

                // Kalkulasi Metrik Agregat
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

                // 4. SIMPAN KE SPREADSHEET
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

            await sleep(3000 + Math.random() * 3000);
        }

        console.log("🏁 Semua target Instagram selesai diproses.");
        browser.disconnect();

    } catch (error) {
        console.error("Critical Error:", error);
    }
}

runInstagramBot();