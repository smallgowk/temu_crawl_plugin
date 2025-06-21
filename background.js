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
const maxPages = 50;

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

// Main Logic
// =================================================================================================
async function handleFetchTemuProducts(message, sendResponse) {
    // ================== CONFIG ==================
    const ENABLE_CONSUMER = true; // Đặt thành false để chỉ chạy luồng Producer (crawl danh sách)
    // ==========================================

    const LIST_API_URL = 'http://iamhere.vn:89/api/ggsheet/pushTemuProduct';
    const DETAIL_API_URL = 'http://iamhere.vn:89/api/ggsheet/pushTemuProductDetail';
    const { sheetId, tabId, tabUrl } = message;

    // --- Logic tạo baseSignature ---
    let baseSignature = 'general_crawl';
    const sanitizeForSheetName = (name) => {
        if (!name) return 'untitled';
        return decodeURIComponent(name).trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/[\s-]+/g, '_');
    };

    try {
        const url = new URL(tabUrl);
        if (url.pathname.includes('/search_result.html')) {
            const searchKey = url.searchParams.get('search_key');
            if (searchKey) baseSignature = sanitizeForSheetName(searchKey);
        } else if (url.pathname.match(/-m-\d+\.html$/)) {
            const [{ result: h1Text }] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => document.querySelector('h1.PX7EseE2._2DshZJ_y')?.textContent
            });
            if (h1Text) baseSignature = sanitizeForSheetName(h1Text);
        }
    } catch (e) {
        console.error("Could not generate base signature, using default.", e);
    }
    // --- Kết thúc logic ---

    const productQueue = [];
    let producerFinished = false;

    // --- Luồng PRODUCER: Crawl danh sách và đẩy vào queue ---
    const runProducer = async () => {
        const crawledProductIds = new Set();
        let pageCount = 0;
        const MAX_PAGES = 10;
        let hasMoreItems = true;

        while (hasMoreItems && pageCount < MAX_PAGES && isTaskRunning) {
            pageCount++;
            const currentSignature = `${baseSignature}_page_${pageCount}`;
            chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `(Producer) Scanning page ${pageCount}...`, isTaskRunning: true } });

            const [{ result: productsOnPage }] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    const regex = /^\/(.*)-(\d{10,})\.html$/;
                    return anchors.map(a => {
                        const match = a.getAttribute('href').match(regex);
                        if (match && a.querySelector('span.C9HMW0KN')) {
                            const productId = match[2];
                            const productLink = `https://www.temu.com${a.getAttribute('href')}`;
                            return { productId, productLink };
                        }
                        return null;
                    }).filter(Boolean);
                }
            });

            const newProducts = productsOnPage ? productsOnPage.filter(p => !crawledProductIds.has(p.productId)) : [];

            if (newProducts.length > 0) {
                newProducts.forEach(p => {
                    crawledProductIds.add(p.productId);
                    productQueue.push({ ...p, pageFoundOn: pageCount });
                });

                await fetch(LIST_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sheetId, signature: currentSignature, listProducts: newProducts })
                });
            }
            
            const [{ result: clickResult }] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const button = document.querySelector('div._2ugbvrpI._3E4sGl93._28_m8Owy.R8mNGZXv._2rMaxXAr[role="button"]');
                    if (button) {
                        button.click();
                        return { success: true };
                    }
                    return { success: false };
                }
            });
            
            hasMoreItems = clickResult && clickResult.success;
            if (hasMoreItems) await new Promise(resolve => setTimeout(resolve, 5000));
        }
        producerFinished = true;
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `(Producer) Finished. Found ${crawledProductIds.size} total products.`, isTaskRunning: true } });
    };

    // --- Luồng CONSUMER: Lấy chi tiết từ queue ---
    const runConsumer = async () => {
        let processedCount = 0;
        let consumerIsPaused = false;

        while (true) {
            if (!isTaskRunning) break;
            
            if (consumerIsPaused) {
                if (producerFinished) break;
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            if (productQueue.length > 0) {
                const product = productQueue.shift();
                processedCount++;
                const currentSignature = `${baseSignature}_page_${product.pageFoundOn}`;
                chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `(Consumer) Processing ${processedCount}... Queue: ${productQueue.length}`, isTaskRunning: true } });

                let productDetailForApi;
                let detailTab;
                let shouldCloseTab = true;

                try {
                    detailTab = await chrome.tabs.create({ url: product.productLink, active: false });
                    const [{ result: executionResult }] = await chrome.scripting.executeScript({
                        target: { tabId: detailTab.id },
                        func: async () => {
                            const totalTimeout = 20000;
                            const pollInterval = 500;
                            let elapsedTime = 0;

                            while (elapsedTime < totalTimeout) {
                                if (document.querySelector('div.DH5-hSGT')) {
                                    return { status: 'CAPTCHA_DETECTED' };
                                }
                                
                                const scripts = Array.from(document.querySelectorAll('script'));
                                const targetPrefix = 'window.rawData=';
                                for (const script of scripts) {
                                    const content = script.textContent;
                                    const rawDataIndex = content.indexOf(targetPrefix);
                                    if (rawDataIndex !== -1) {
                                        let rawDataStr = content.substring(rawDataIndex + targetPrefix.length).trim();
                                        const lastBraceIndex = rawDataStr.lastIndexOf('}');
                                        if (lastBraceIndex !== -1) rawDataStr = rawDataStr.substring(0, lastBraceIndex + 1);
                                        
                                        try {
                                            const parsed = JSON.parse(rawDataStr);
                                            if (parsed && parsed.store &&
                                                parsed.store.goods && Object.keys(parsed.store.goods).length > 0 &&
                                                parsed.store.delivery && Object.keys(parsed.store.delivery).length > 0) {
                                                return { status: 'SUCCESS', data: rawDataStr };
                                            }
                                        } catch (e) { /* Data chưa hoàn chỉnh, tiếp tục đợi */ }
                                    }
                                }
                                await new Promise(resolve => setTimeout(resolve, pollInterval));
                                elapsedTime += pollInterval;
                            }
                            return { status: 'TIMEOUT' };
                        }
                    });
                    
                    if (executionResult.status === 'SUCCESS') {
                         const detailObj = JSON.parse(executionResult.data);
                         const cleanedStore = { goods: detailObj.store.goods, delivery: detailObj.store.delivery };
                         productDetailForApi = JSON.stringify({ store: cleanedStore });
                    } else if (executionResult.status === 'CAPTCHA_DETECTED') {
                        shouldCloseTab = false;
                        await chrome.tabs.update(detailTab.id, { active: true });
                        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: { status: `Captcha detected! Consumer is paused. Producer continues...`, isTaskRunning: true }});
                        consumerIsPaused = true;
                        productDetailForApi = JSON.stringify({ error: "Verify captcha" });
                    } else { // TIMEOUT
                        throw new Error("Không tìm thấy dữ liệu chi tiết sau 20 giây.");
                    }
                } catch (error) {
                    console.error(`Error processing ${product.productId}:`, error);
                    productDetailForApi = JSON.stringify({ error: error.message });
                } finally {
                    if (detailTab && shouldCloseTab) {
                        await chrome.tabs.remove(detailTab.id);
                    }
                }
                
                if (productDetailForApi) {
                    await fetch(DETAIL_API_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            sheetId,
                            signature: currentSignature,
                            productId: product.productId,
                            productDetail: productDetailForApi
                        })
                    });
                }
            } else if (producerFinished) {
                break;
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return consumerIsPaused;
    };

    // --- Khởi chạy song song và đợi cả 2 hoàn thành ---
    try {
        const producerPromise = runProducer();
        const consumerPromise = ENABLE_CONSUMER ? runConsumer() : Promise.resolve(false);

        const [_, wasPausedByCaptcha] = await Promise.all([producerPromise, consumerPromise]);

        if (!ENABLE_CONSUMER) {
            currentTrackingStatus = { status: `Producer finished. Consumer was disabled.`, isTaskRunning: false };
        } else if (wasPausedByCaptcha) {
            currentTrackingStatus = { status: `Process finished. Producer completed. Consumer was paused due to captcha.`, isTaskRunning: false };
        } else {
            currentTrackingStatus = { status: `All tasks completed!`, isTaskRunning: false };
        }
        isTaskRunning = false;
    } catch (error) {
        console.error("A critical error occurred:", error);
        currentTrackingStatus = { status: `Critical Error: ${error.message}`, isTaskRunning: false };
        isTaskRunning = false;
    } finally {
        chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', data: currentTrackingStatus });
        sendResponse({ success: true });
    }
}