require('dotenv').config();
const { google } = require('googleapis');
const puppeteer = require('puppeteer-core');
const { saveAffiliateToDB } = require('./database'); // Pastikan ini di-import

const DEBUG_PORT = 9222;

// --- CONFIG GOOGLE SHEETS ---
const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SOURCE_SHEET = '01 Listing';
const TARGET_SHEET = '02 Analysis TiktokShop';

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
        range: `${SOURCE_SHEET}!A3:Z`, 
    });
    
    const rows = response.data.values || [];
    if (rows.length < 2) return [];

    const headers = rows[0]; 
    const dataRows = rows.slice(1); 
    
    let ttAffiliateIdx = 22; //headers.findIndex(h => h && h.toLowerCase().includes('tiktok affiliate name')) || 22;
    
    if (ttAffiliateIdx === -1) {
        console.log("⚠️ Kolom 'Tiktok Affiliate Name' tidak ditemukan di header. Menggunakan nama default.");
    }

    const targets = [];
    
    dataRows.forEach((row) => {
        const listingName = row[2]; // C: Username/Name
        
        let tiktokAffiliateName = null;
        if (ttAffiliateIdx !== -1) {
            tiktokAffiliateName = row[ttAffiliateIdx];
        }
        
        const targetName = tiktokAffiliateName && tiktokAffiliateName.trim() !== "" 
                            ? tiktokAffiliateName.trim() 
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
            range: `${TARGET_SHEET}!A${existingRowNumber}:L${existingRowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   🔄 Data TiktokShop diperbarui pada baris ${existingRowNumber}`);
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${TARGET_SHEET}!A:L`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
        console.log(`   ➕ Data TiktokShop ditambahkan sebagai baris baru`);
    }
}

// --- MAIN BOT LOGIC ---
async function runTiktokShopBot() {
    try {
        console.log("📥 [TikTok Shop] Mengambil daftar target dari Spreadsheet...");
        let dataset = await getTargetsFromSheet();

        if (dataset.length === 0) return console.log("⚠️ Tidak ada target TikTok Affiliate ditemukan.");
        console.log(`✅ Ditemukan ${dataset.length} target TikTok Affiliate.`);

        console.log("🔍 Mengecek histori data di Target Sheet...");
        const existingDataMap = await getExistingDataMap();

        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const nowMs = Date.now();

        // --- FASE 1: PEMETAAN & EVALUASI WAKTU UPDATE ---
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

        // --- FASE 2: PENGURUTAN (SORTING) ---
        dataset.sort((a, b) => a.lastUpdateMs - b.lastUpdateMs);

        console.log("🌐 Menyiapkan environment Chrome...");
        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}` });
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        // --- FASE 3: PRE-FLIGHT (MEMUAT COOKIES TIKTOK SHOP) ---
        console.log("⏳ Memuat ulang sesi login TikTok Shop Affiliate...");
        await page.bringToFront();
        await page.goto("https://seller-id.tokopedia.com/affiliate/landing?shop_region=ID", { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(4000);
        
        console.log("🔗 Berpindah ke dashboard Creator Connection...");
        await page.goto("https://affiliate-id.tokopedia.com/connection/creator?shop_region=ID", { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000); 

        let processCounter = 0;

        // --- FASE 4: PENCARIAN CREATOR ---
        for (let item of dataset) {
            processCounter++;
            const { originalName, targetName, lastUpdateMs, existingRowNumber, isNew } = item;

            if (!isNew && (nowMs - lastUpdateMs) < ONE_WEEK_MS) {
                console.log(`\n[${processCounter}/${dataset.length}] ⏭️ Melewati ${originalName} (Data baru saja diperbarui)`);
                continue; 
            }

            console.log(`\n[${processCounter}/${dataset.length}] ${isNew ? '➕' : '🔄'} Mencari Creator: ${targetName} (Untuk: ${originalName})`);

            try {
                // 1. Eksekusi Pencarian
                const apiResponse = await page.evaluate(async (queryName) => {
                    try {
                        const payload = {
                            "query": queryName,
                            "pagination": { "size": 12, "page": 0 },
                            "query_type": 1,
                            "filter_params": {},
                            "algorithm": 1
                        };

                        const response = await fetch("https://affiliate-id.tokopedia.com/api/v1/oec/affiliate/creator/marketplace/find?user_language=id-ID&aid=4331&app_name=i18n_ecom_alliance&device_id=0&device_platform=web&cookie_enabled=true&screen_width=1920&screen_height=1080&browser_language=en-US&browser_platform=Win32&browser_name=Mozilla&browser_version=5.0+(Windows+NT+10.0%3B+Win64%3B+x64)+AppleWebKit%2F537.36+(KHTML,+like+Gecko)+Chrome%2F145.0.0.0+Safari%2F537.36&browser_online=true&timezone_name=Asia%2FJakarta&oec_seller_id=7494713578821290554&shop_region=ID&msToken=h5thrsoD65mmbLQ37HrpOIqieuRvdfRIy0f95o4aLc3F7Qpl4RGtJnuYVK68Mexh1X_9XXYfWsQgmahqy84ZU0oYoOQZWpKZmOe7VYPDMRbLFzAekOq00AI4GbNwdaiK2xODZdM=&X-Bogus=DFSzswVLBcGy5-CFCiQ-WS6-55xg&X-Gnarly=MHE8OIxnrsA2Z2HfK82YAlCZfEiwRguP4vGbwHsUT2wp-1utRK3kPOcaRl-OncnObV8gDZQrn-kGS6TR-BVsnk3oCCFhWWg5UfbfMLZeGjA56WMz02G6/tdeU57YdJtSkcAL3Ni36D5DIvgaIupNislfyVlPGDPT2Mg9m978gxQ-ytnXkB4t/TIGmSC8izaKMJ-zMD695L2L2s/xpxLWrpLYe72bDAUwVVY6zljI-OY/Q7-RmoI0Wcmy7nhUcd8r6ZauQzsvfEgd", {
                            "headers": {
                                "accept": "application/json, text/plain, */*",
                                "accept-language": "en-US,en;q=0.9",
                                "content-type": "application/json",
                                "priority": "u=1, i"
                            },
                            "body": JSON.stringify(payload),
                            "method": "POST",
                        });

                        return await response.json();
                    } catch (e) {
                        return { error: e.message };
                    }
                }, targetName);

                if (apiResponse.error || apiResponse.code !== 0) {
                    console.log(`   ❌ Fetch Error / Ditolak TikTok:`, apiResponse.error || apiResponse.message);
                    continue;
                }

                const creatorList = apiResponse.creator_profile_list || [];
                if (creatorList.length === 0) {
                    console.log(`   ℹ️ User '${targetName}' tidak ditemukan.`);
                    continue;
                }

                // --- 2. Smart Filter Pencarian ---
                let bestMatch = null;
                let highestMatchScore = -1;

                creatorList.forEach(creator => {
                    let matchScores = [];
                    const handle = creator.handle?.value || "";
                    const nickname = creator.nickname?.value || "";

                    matchScores.push(calculateSimilarity(targetName, nickname));
                    matchScores.push(calculateSimilarity(targetName, handle));

                    let maxScoreForItem = Math.max(...matchScores);
                    if (maxScoreForItem > highestMatchScore) {
                        highestMatchScore = maxScoreForItem;
                        bestMatch = creator;
                    }
                });

                if (!bestMatch || highestMatchScore < 90) continue;
                
                // --- 3. Membentuk Data Awal Payload ---
                let payload = {
                    listingName: originalName,
                    affiliateName: bestMatch.nickname?.value || "Unknown",
                    handle: bestMatch.handle?.value || "Unknown",
                    category: (bestMatch.category?.value || []).map((n) => n.name),
                    affiliateID: bestMatch.creator_oecuid?.value || "",
                    level: bestMatch.creator_level?.value || 0
                };

                if (!payload.affiliateID) {
                    console.log(`   ❌ Tidak ada Affiliate ID (creator_oecuid) untuk ${targetName}.`);
                    continue;
                }

                console.log(`   🎯 Match Terbaik: ${payload.affiliateName} (@${payload.handle}) - Akurasi: ${highestMatchScore.toFixed(2)}%`);
                console.log(`   🔗 Menyadap data analitik mendalam untuk CID: ${payload.affiliateID}...`);

                // --- 4. Intercept Detail Profile (Response XHR) ---
                let profileResponses = [];
                
                const profileInterceptor = async (response) => {
                    const url = response.url();
                    // Hilangkan tanda '?' di akhir pencarian agar lebih fleksibel menangkap URL
                    if (url.includes('/api/v1/oec/affiliate/creator/marketplace/profile')) {
                        try {
                            const json = await response.json();
                            
                            // PERBAIKAN: TikTok terkadang langsung merespons dengan creator_profile, bukan di dalam json.data
                            if (json && json.code === 0) {
                                const responseBody = json.data || json; // Ambil json.data jika ada, jika tidak pakai root json
                                
                                if (responseBody && responseBody.creator_profile) {
                                    profileResponses.push(responseBody);
                                    console.log(`      📥 Paket Data Profil tertangkap (${profileResponses.length})`);
                                }
                            }
                        } catch(e) {}
                    }
                };

                page.on('response', profileInterceptor);

                const detailUrl = `https://affiliate-id.tokopedia.com/connection/creator/detail?cid=${payload.affiliateID}`;
                await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                
                // PERBAIKAN WAKTU & SCROLL (Memancing Lazy-Loading TikTok)
                await sleep(3000); 
                console.log(`      📜 Menggulir halaman untuk memancing request data...`);
                await page.evaluate(() => window.scrollBy(0, 800));
                
                await sleep(3000);
                await page.evaluate(() => window.scrollBy(0, 800));
                
                await sleep(3000); 

                page.off('response', profileInterceptor);

                payload.profileData = profileResponses;

                if (profileResponses.length > 0) {
                    console.log(`   ✅ Selesai mengumpulkan ${profileResponses.length} bongkah data analitik.`);
                    
                    // --- 5. EKSTRAKSI DATA DARI 5 RESPONSE JSON ---
                    let follower_genders = [];
                    let follower_ages = [];
                    let units_sold = "0";
                    let avg_revenue_per_buyer_range = "0";
                    let med_gmv_revenue_range = "0";

                    // Fungsi Pengonversi Rupiah Range
                    const parseRupiahRange = (str) => {
                        if (!str) return 0;
                        let cleanStr = str.replace(/Rp|\+|>|\s/g, '').split('-')[0].trim();
                        if (!cleanStr) return 0;

                        let multiplier = 1;
                        if (cleanStr.toUpperCase().includes('JT')) {
                            multiplier = 1000000;
                            cleanStr = cleanStr.replace(/JT/i, '').replace(',', '.');
                        } else if (cleanStr.toUpperCase().includes('RB')) {
                            multiplier = 1000;
                            cleanStr = cleanStr.replace(/RB/i, '').replace(',', '.');
                        } else if (cleanStr.toUpperCase().includes('M')) {
                            multiplier = 1000000000;
                            cleanStr = cleanStr.replace(/M/i, '').replace(',', '.');
                        }

                        const num = parseFloat(cleanStr);
                        return isNaN(num) ? 0 : Math.floor(num * multiplier);
                    };

                    for (let res of profileResponses) {
                        if (!res.creator_profile) continue;
                        const profile = res.creator_profile;

                        if (profile.follower_genders_v2 && profile.follower_genders_v2.value) {
                            follower_genders = profile.follower_genders_v2.value;
                        }
                        if (profile.follower_ages_v2 && profile.follower_ages_v2.value) {
                            follower_ages = profile.follower_ages_v2.value;
                        }
                        if (profile.units_sold && profile.units_sold.value) {
                            units_sold = profile.units_sold.value;
                        }
                        if (profile.avg_revenue_per_buyer_range && profile.avg_revenue_per_buyer_range.value) {
                            avg_revenue_per_buyer_range = parseRupiahRange(profile.avg_revenue_per_buyer_range.value);
                        }
                        if (profile.med_gmv_revenue_range && profile.med_gmv_revenue_range.value) {
                            med_gmv_revenue_range = parseRupiahRange(profile.med_gmv_revenue_range.value);
                        }
                    }

                    payload.extractedData = {
                        follower_genders: follower_genders,
                        follower_ages: follower_ages,
                        units_sold: parseInt(units_sold, 10) || 0,
                        avg_revenue_per_buyer: avg_revenue_per_buyer_range,
                        med_gmv_revenue: med_gmv_revenue_range
                    };

                    console.log(`   📊 Stats Extracted -> Sold: ${payload.extractedData.units_sold} | GMV Est: Rp${payload.extractedData.med_gmv_revenue.toLocaleString('id-ID')}`);

                    // Logic Gender (Mencari Pria dan Wanita dengan aman)
                    let priaRatio = 0, wanitaRatio = 0;
                    if (payload.extractedData.follower_genders.length > 0) {
                        const m = payload.extractedData.follower_genders.find(g => g.key.toLowerCase() === 'male');
                        const f = payload.extractedData.follower_genders.find(g => g.key.toLowerCase() === 'female');
                        if (m) priaRatio = m.value || 0;
                        if (f) wanitaRatio = f.value || 0;
                    }

                    // Logic Umur (Mencari Ratio Tertinggi)
                    let mapMostAges = { key: "Unknown", value: 0 };
                    if (payload.extractedData.follower_ages && payload.extractedData.follower_ages.length > 0) {
                        // Mengurutkan array umur berdasarkan value terbesar ke terkecil
                        const sortedAges = [...payload.extractedData.follower_ages].sort((a, b) => parseFloat(b.value || 0) - parseFloat(a.value || 0));
                        mapMostAges = sortedAges[0];
                    }

                    // --- 6. SUSUN DATA SPREADSHEET (A - L) ---
                    let rowData = new Array(12).fill('');
                    rowData[0] = new Date().toLocaleString('id-ID'); // A: Update Time
                    rowData[1] = payload.listingName;                // B: Username/Name
                    rowData[2] = payload.category.join(", ");        // C: Category By Tiktokshop
                    rowData[3] = payload.affiliateID;                // D: Affiliate ID
                    
                    rowData[4] = payload.extractedData.avg_revenue_per_buyer; // F: Avg Revenue per Buyer
                    rowData[5] = payload.extractedData.units_sold;            // E: Units Sold
                    rowData[6] = payload.extractedData.med_gmv_revenue;       // G: Med GMV Revenue
                    
                    rowData[7] = priaRatio;                          // H: Pria (Ratio)
                    rowData[8] = wanitaRatio;                        // I: Wanita (Ratio)
                    
                    rowData[9] = mapMostAges.key;                    // J: Usia (Type String)
                    rowData[10] = mapMostAges.value;                 // K: Usia (Ratio)

                    rowData[11] = payload.level;                     // L: Level

                    // SIMPAN KE SPREADSHEET
                    await saveToTargetSheet(rowData, existingRowNumber);
                    
                    if (isNew) {
                        existingDataMap.set(originalName.toLowerCase(), {
                            rowNumber: 99999,
                            lastUpdate: rowData[0]
                        });
                    }

                    // SIMPAN KE SQLITE DATABASE
                    try {
                        await saveAffiliateToDB(payload.affiliateID, payload);
                        console.log(`   💾 Tersimpan ke SQLite Database`);
                    } catch (dbErr) {
                        console.log(`   ❌ Gagal menyimpan ke SQLite: ${dbErr.message}`);
                    }

                } else {
                    console.log(`   ⚠️ Halaman detail terbuka, namun tidak ada request profil yang berhasil disadap.`);
                }

            } catch (err) {
                console.error(`   ❌ System Error saat memproses ${targetName}: ${err.message}`);
            }

            await sleep(4000 + Math.random() * 3000); 
        }

        console.log("\n🏁 Proses Ekstraksi TikTok Shop Selesai.");
        browser.disconnect();

    } catch (error) {
        console.error("Critical Error:", error);
    }
}

runTiktokShopBot();