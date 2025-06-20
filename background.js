// Background script - Removed Auto-rerun functionality
let isCrawling = false;
let currentTabId = null;
let crawledItemIds = new Set();
let currentTrackingStatus = null;
let isTaskRunning = false;
let lastTrackingMessage = null;

// Function to reset crawling state
function resetCrawlingState() {
    isCrawling = false;
    currentTabId = null;
    crawledItemIds.clear();
    pageCount = 0;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_CRAWL') {
        if (!isCrawling) {
            isCrawling = true;
            currentTabId = message.tabId;
            crawledItemIds.clear();
            startCrawling(message.tabId);
            sendResponse({ success: true });
        } else {
            // If crawling is stuck, allow force reset
            if (message.forceReset) {
                resetCrawlingState();
                isCrawling = true;
                currentTabId = message.tabId;
                startCrawling(message.tabId);
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, message: 'Crawling already in progress' });
            }
        }
    } else if (message.type === 'STOP_CRAWL') {
        resetCrawlingState();
        sendResponse({ success: true });
    } else if (message.type === 'RESET_CRAWL_STATE') {
        resetCrawlingState();
        sendResponse({ success: true });
    } else if (message.type === 'START_FETCH_TRACKING') {
        if (isTaskRunning) {
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, isTaskRunning: true } });
            sendResponse({ success: false, message: 'Task already running' });
            return true;
        }
        isTaskRunning = true;
        currentTrackingStatus = { ...currentTrackingStatus, isTaskRunning: true };
        lastTrackingMessage = message;
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, status: 'Started tracking...', isTaskRunning: true } });
        handleFetchTracking(message, sender, sendResponse);
        sendResponse({ success: true });
        return true;
    } else if (message.type === 'STOP_FETCH_TRACKING') {
        isTaskRunning = false;
        currentTrackingStatus = { ...currentTrackingStatus, isTaskRunning: false };
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, status: 'Stopped by user.', isTaskRunning: false } });
        sendResponse({ success: true });
        return true;
    } else if (message.type === 'GET_CURRENT_STATUS') {
        sendResponse({ ...currentTrackingStatus, isTaskRunning });
        return true;
    } else if (message.type === 'START_FETCH_TEMU_PRODUCTS') {
        if (isTaskRunning) {
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, isTaskRunning: true } });
            sendResponse({ success: false, message: 'Task already running' });
            return true;
        }

        // Lấy thông tin tab hiện tại một cách tường minh để tránh lỗi
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || tabs.length === 0) {
                isTaskRunning = false;
                sendResponse({ success: false, message: 'Could not find active tab.' });
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Error: No active tab found.', isTaskRunning: false } });
                return;
            }
            const activeTab = tabs[0];
            
            isTaskRunning = true;
            const messageForHandler = { 
                ...message, 
                tabId: activeTab.id, 
                tabUrl: activeTab.url 
            };
            
            currentTrackingStatus = { ...currentTrackingStatus, isTaskRunning: true, status: 'Starting...' };
            lastTrackingMessage = messageForHandler;
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            
            handleFetchTemuProducts(messageForHandler, sendResponse);

            sendResponse({ success: true, message: 'Task started' });
        });
        
        return true; // Báo hiệu rằng sendResponse sẽ được gọi bất đồng bộ
    } else if (message.type === 'STOP_FETCH') {
        isTaskRunning = false;
        currentTrackingStatus = { ...currentTrackingStatus, isTaskRunning: false };
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { ...currentTrackingStatus, status: 'Stopped by user.', isTaskRunning: false } });
        sendResponse({ success: true });
        return true;
    }
    return true;
});

// Function to find and click next button
async function findAndClickNext(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: () => {
                const nextButtons = Array.from(document.querySelectorAll('div[style*="background-image"]'));
                if (nextButtons.length > 0) {
                    const nextButton = nextButtons[nextButtons.length - 1];
                    if (nextButton && nextButton.offsetParent !== null) {
                        nextButton.click();
                        return true;
                    }
                }
                return false;
            }
        });
        return results && results[0] && results[0].result;
    } catch (error) {
        console.error('Error finding/clicking next button:', error);
        return false;
    }
}

// Function to crawl a single page
async function crawlPage(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: () => {
                try {
                    const links = Array.from(document.querySelectorAll('a[href*="/item/"]'));
                    const itemIds = links.map(link => {
                        const match = link.href.match(/\/item\/(\d+)/);
                        return match ? match[1] : null;
                    }).filter(id => id !== null);
                    return [...new Set(itemIds)];
                } catch (error) {
                    console.error('Error in content script:', error);
                    throw error;
                }
            }
        });

        if (results && results[0] && results[0].result) {
            const newIds = results[0].result;
            newIds.forEach(id => crawledItemIds.add(id));
            
            // Update popup status if it's open
            chrome.runtime.sendMessage({
                type: 'UPDATE_STATUS',
                data: {
                    currentPage: pageCount,
                    totalItems: crawledItemIds.size
                }
            });
            
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error crawling page:', error);
        return false;
    }
}

let pageCount = 0;
const maxPages = 10;

// Main crawling function
async function startCrawling(tabId) {
    try {
        pageCount = 0;
        
        while (pageCount < maxPages && isCrawling) {
            pageCount++;
            
            // Crawl current page
            const success = await crawlPage(tabId);
            if (!success) {
                chrome.runtime.sendMessage({
                    type: 'CRAWL_ERROR',
                    error: 'Failed to crawl page'
                });
                break;
            }

            // Try to find and click next button
            const hasNext = await findAndClickNext(tabId);
            if (!hasNext) {
                chrome.runtime.sendMessage({
                    type: 'CRAWL_COMPLETE',
                    data: {
                        totalItems: crawledItemIds.size
                    }
                });
                break;
            }

            // Wait for page to load
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (error) {
        console.error('Error in startCrawling:', error);
        chrome.runtime.sendMessage({
            type: 'CRAWL_ERROR',
            error: error.message
        });
    } finally {
        // Always reset crawling state when done
        resetCrawlingState();
    }
}

async function handleFetchTracking(message, sender, sendResponse) {
    const BASE_API_URL = 'http://iamhere.vn:89/api/ggsheet';
    const { sheetId, sheetName, tabId } = message;
    try {
        currentTrackingStatus = { currentPage: 0, totalItems: 0, status: 'Fetching orderId list from Google Sheet...', isTaskRunning: true };
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
        
        const infoRes = await fetch(`${BASE_API_URL}/getInfo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: sheetId, sheetName })
        });
        if (!infoRes.ok) throw new Error('Error calling getInfo API');
        
        const infoData = await infoRes.json();
        if (!infoData.data || !Array.isArray(infoData.data)) throw new Error('Invalid API response');
        
        const orderIds = infoData.data;
        if (orderIds.length === 0) throw new Error('No orderId found in sheet!');
        
        currentTrackingStatus = { currentPage: 0, totalItems: orderIds.length, status: `Crawling tracking number for ${orderIds.length} orderId...`, isTaskRunning: true };
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
        
        for (let i = 0; i < orderIds.length; i++) {
            // Check if task was stopped
            if (!isTaskRunning) {
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Task stopped by user', isTaskRunning: false } });
                return;
            }
            
            const orderId = orderIds[i];
            currentTrackingStatus = { currentPage: i+1, totalItems: orderIds.length, status: `(${i+1}/${orderIds.length}) Getting tracking for orderId: ${orderId}`, isTaskRunning: true };
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            
            // Open tracking tab
            const trackingUrl = `https://www.aliexpress.com/p/tracking/index.html?_addShare=no&_login=yes&tradeOrderId=${orderId}`;
            const trackingTab = await chrome.tabs.create({ url: trackingUrl, active: false });
            await new Promise(resolve => setTimeout(resolve, 4000));
            
            // Inject script to get tracking number
            const [{ result: trackingNumberRaw }] = await chrome.scripting.executeScript({
                target: { tabId: trackingTab.id },
                func: () => {
                    const el = document.querySelector('.logistic-info-v2--mailNoValue--X0fPzen');
                    return el ? el.textContent.trim() : '';
                }
            });
            const trackingNumber = trackingNumberRaw || 'Error!';
            await chrome.tabs.remove(trackingTab.id);
            
            // Update sheet
            currentTrackingStatus = { currentPage: i+1, totalItems: orderIds.length, status: `Updating tracking for orderId: ${orderId}...`, isTaskRunning: true };
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            
            const datamap = {};
            datamap[orderId] = trackingNumber;
            const updateRes = await fetch(`${BASE_API_URL}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: sheetId, sheetName, datamap })
            });
            
            if (!updateRes.ok) {
                currentTrackingStatus = { currentPage: i+1, totalItems: orderIds.length, status: `Error updating orderId: ${orderId}`, isTaskRunning: true };
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            } else {
                currentTrackingStatus = { currentPage: i+1, totalItems: orderIds.length, status: `Updated tracking for orderId: ${orderId}`, isTaskRunning: true };
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
            }
        }
        
        currentTrackingStatus = { currentPage: orderIds.length, totalItems: orderIds.length, status: 'All tracking numbers updated!', isTaskRunning: false };
        isTaskRunning = false;
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
        
    } catch (error) {
        currentTrackingStatus = { currentPage: 0, totalItems: 0, status: 'Error: ' + error.message, isTaskRunning: false };
        isTaskRunning = false;
        chrome.runtime.sendMessage({ type: 'CRAWL_ERROR', error: error.message });
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
    }
}

async function handleFetchTemuProducts(message, sendResponse) {
    const LIST_API_URL = 'http://iamhere.vn:89/api/ggsheet/pushTemuProduct';
    const DETAIL_API_URL = 'http://iamhere.vn:89/api/ggsheet/pushTemuProductDetail';
    const { sheetId, tabId, tabUrl } = message;

    // --- Logic tạo baseSignature ---
    let baseSignature = 'general_crawl';
    const sanitizeForSheetName = (name) => {
        if (!name) return 'untitled';
        // Chuyển thành chữ thường, thay thế khoảng trắng và các ký tự không phải chữ/số bằng dấu gạch dưới
        return decodeURIComponent(name).trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '_');
    };

    try {
        const url = new URL(tabUrl);
        if (url.pathname.includes('/search_result.html')) {
            const searchKey = url.searchParams.get('search_key');
            if (searchKey) {
                baseSignature = sanitizeForSheetName(searchKey);
            }
        } else if (url.pathname.match(/-m-\d+\.html$/)) {
            const [{ result: h1Text }] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => document.querySelector('h1.PX7EseE2._2DshZJ_y')?.textContent
            });
            if (h1Text) {
                baseSignature = sanitizeForSheetName(h1Text);
            }
        }
    } catch (e) {
        console.error("Could not generate base signature, using default.", e);
    }
    // --- Kết thúc logic tạo baseSignature ---

    const crawledProductIds = new Set();
    let hasMoreItems = true;
    let pageCount = 0;
    const MAX_PAGES = 10; // Giới hạn số page để tránh loop vô hạn

    try {
        while (hasMoreItems && pageCount < MAX_PAGES && isTaskRunning) {
            pageCount++;
            const currentSignature = `${baseSignature}_page_${pageCount}`; // Tạo signature động với định dạng mới
            currentTrackingStatus = { status: `Crawling page ${pageCount} for '${currentSignature}'...`, isTaskRunning: true };
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });

            // Crawl items trên page hiện tại
            const [{ result: newProducts }] = await chrome.scripting.executeScript({
                target: { tabId },
                func: (existingIds) => {
                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    const regex = /^\/(.*)-(\d{10,})\.html$/;
                    const list = anchors.map(a => {
                        const match = a.getAttribute('href').match(regex);
                        if (match && a.querySelector('span.C9HMW0KN')) {
                            const productId = match[2];
                            // Chỉ lấy các item chưa crawl
                            if (!existingIds.includes(productId)) {
                                const productLink = `https://www.temu.com${a.getAttribute('href')}`;
                                return { productId, productLink };
                            }
                        }
                        return null;
                    }).filter(Boolean);
                    return list;
                },
                args: [Array.from(crawledProductIds)] // Truyền danh sách productId đã crawl
            });

            // Nếu tìm thấy items mới
            if (newProducts && newProducts.length > 0) {
                currentTrackingStatus = { status: `Found ${newProducts.length} new products on page ${pageCount}. Pushing to API...`, isTaskRunning: true };
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });

                // Gọi API với chỉ các items mới
                const listRes = await fetch(LIST_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sheetId,
                        signature: currentSignature, // Sử dụng signature động
                        listProducts: newProducts
                    })
                });
                if (!listRes.ok) throw new Error(`API pushTemuProduct failed for page ${pageCount}`);

                // Lưu các productId đã crawl
                newProducts.forEach(p => crawledProductIds.add(p.productId));
                
                // Crawl chi tiết từng sản phẩm
                for (const product of newProducts) {
                    if (!isTaskRunning) {
                        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: 'Task stopped by user', isTaskRunning: false } });
                        return;
                    }
                    currentTrackingStatus = { status: `(${crawledProductIds.size}) Crawling detail for ${product.productId}...`, isTaskRunning: true };
                    chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
                    
                    // Open a new tab for the product link
                    const detailTab = await chrome.tabs.create({ url: product.productLink, active: false });

                    try {
                        // Lấy rawData từ script tag, với cơ chế đợi thông minh đến khi data được điền
                        const [{ result: rawDataString }] = await chrome.scripting.executeScript({
                            target: { tabId: detailTab.id },
                            func: async () => {
                                const totalTimeout = 20000; // Đợi tối đa 20 giây
                                const pollInterval = 500;   // Kiểm tra mỗi 500ms
                                let elapsedTime = 0;

                                while (elapsedTime < totalTimeout) {
                                    const scripts = Array.from(document.querySelectorAll('script'));
                                    const targetPrefix = 'window.rawData=';
                                    for (const script of scripts) {
                                        const content = script.textContent;
                                        const rawDataIndex = content.indexOf(targetPrefix);
                                        if (rawDataIndex !== -1) {
                                            let rawDataStr = content.substring(rawDataIndex + targetPrefix.length).trim();
                                            const lastBraceIndex = rawDataStr.lastIndexOf('}');
                                            if (lastBraceIndex !== -1) {
                                                rawDataStr = rawDataStr.substring(0, lastBraceIndex + 1);
                                            }
                                            
                                            // Kiểm tra xem data đã đủ chưa (goods và delivery không rỗng)
                                            try {
                                                const parsed = JSON.parse(rawDataStr);
                                                if (parsed && parsed.store && 
                                                    parsed.store.goods && Object.keys(parsed.store.goods).length > 0 &&
                                                    parsed.store.delivery && Object.keys(parsed.store.delivery).length > 0) {
                                                    return rawDataStr; // Dữ liệu đã đủ, trả về
                                                }
                                            } catch (e) { /* Bỏ qua lỗi parse, tiếp tục đợi */ }
                                        }
                                    }
                                    // Đợi rồi thử lại
                                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                                    elapsedTime += pollInterval;
                                }

                                // Hết giờ, trả về null để logic bên ngoài xử lý
                                return null;
                            }
                        });

                        if (rawDataString) {
                            // Đóng tab chi tiết
                            await chrome.tabs.remove(detailTab.id);

                            currentTrackingStatus = { status: `(${crawledProductIds.size}) Pushing detail for ${product.productId}...`, isTaskRunning: true };
                            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });

                            let productDetailForApi = rawDataString;
                            try {
                                const detailObj = JSON.parse(rawDataString);
                                if (detailObj && detailObj.store) {
                                    // Chỉ giữ lại các key cần thiết
                                    const cleanedStore = {
                                        goods: detailObj.store.goods,
                                        delivery: detailObj.store.delivery
                                    };
                                    const finalObject = { store: cleanedStore };
                                    productDetailForApi = JSON.stringify(finalObject);
                                }
                            } catch (e) {
                                console.error('Could not clean JSON, sending raw data.', e);
                            }

                            // Gọi API pushTemuProductDetail
                            const detailRes = await fetch(DETAIL_API_URL, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    sheetId,
                                    signature: currentSignature, // Sử dụng signature động
                                    productId: product.productId,
                                    productDetail: productDetailForApi
                                })
                            });

                            const detailResJson = await detailRes.json();
                        } else {
                            // Nếu không thấy rawData, kiểm tra captcha bằng cách tìm div#Picture
                            const [{ result: hasCaptcha }] = await chrome.scripting.executeScript({
                                target: { tabId: detailTab.id },
                                func: () => !!document.getElementById('Picture')
                            });

                            if (hasCaptcha) {
                                // Dừng process, hiển thị thông báo, không đóng tab
                                isTaskRunning = false;
                                currentTrackingStatus = { status: 'Vui lòng nhập captcha để tiếp tục', isTaskRunning: false };
                                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
                                
                                // Focus vào tab captcha
                                await chrome.tabs.update(detailTab.id, { active: true });
                                return; // Dừng toàn bộ function
                            } else {
                                // Không tìm thấy dữ liệu và cũng không phải captcha -> Dừng toàn bộ process
                                isTaskRunning = false;
                                const statusMessage = `Không tìm thấy dữ liệu cho sản phẩm ${product.productId}. Đã dừng.`;
                                console.error(statusMessage, `URL: ${product.productLink}`);
                                currentTrackingStatus = { status: statusMessage, isTaskRunning: false };
                                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });

                                // Focus vào tab để user kiểm tra
                                await chrome.tabs.update(detailTab.id, { active: true });
                                return; // Dừng toàn bộ function
                            }
                        }
                    } catch (error) {
                        console.error('Error in detail crawling:', error);
                        isTaskRunning = false;
                        currentTrackingStatus = { status: 'Error: ' + error.message, isTaskRunning: false };
                        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
                    }
                }
            }

            // Tìm và click button "See more"
            const [{ result: clickResult }] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    console.log('Searching for See more button...');
                    
                    // Tìm button theo class chính xác
                    const button = document.querySelector('div._2ugbvrpI._3E4sGl93._28_m8Owy.R8mNGZXv._2rMaxXAr[role="button"]');
                    console.log('Found button:', button);

                    if (button) {
                        console.log('Found button, attempting to click...');
                        try {
                            button.click();
                            console.log('Direct click successful');
                            return { found: true, clicked: true };
                        } catch (error) {
                            console.error('Error clicking button:', error);
                            return { found: true, clicked: false, error: error.message };
                        }
                    }
                    
                    console.log('Button not found');
                    return { found: false, clicked: false };
                }
            });

            console.log('Click result:', clickResult);

            if (!clickResult.found) {
                hasMoreItems = false;
                break;
            }

            if (clickResult.found && !clickResult.clicked) {
                console.error('Found button but failed to click:', clickResult.error);
                throw new Error('Failed to click See more button');
            }

            // Tăng thời gian đợi để đảm bảo trang load xong
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        const finalStatus = pageCount >= MAX_PAGES 
            ? `Reached maximum ${MAX_PAGES} pages. Total products: ${crawledProductIds.size}`
            : `Completed! Total products: ${crawledProductIds.size} from ${pageCount} pages`;

        currentTrackingStatus = { status: finalStatus, isTaskRunning: false };
        isTaskRunning = false;
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });

    } catch (error) {
        currentTrackingStatus = { status: 'Error: ' + error.message, isTaskRunning: false };
        isTaskRunning = false;
        chrome.runtime.sendMessage({ type: 'CRAWL_ERROR', error: error.message });
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
    }
}