'use strict';

const userAgentOverride = {};
const activeSessions = {};
const cacheTTL = 60 * 60 * 1000;

const donationItemSKU = 're_view';
const inAppParams = {env: 'prod'};
const defaultIcon = 'icons/browser-action.png';
const activeIcon = 'icons/browser-action-active.png';

var didDonated = false;

window.ga=window.ga||function(){(ga.q=ga.q||[]).push(arguments)};ga.l=+new Date;
ga('create', 'UA-4523560-10', 'auto');
ga('set', 'checkProtocolTask', null);

chrome.browserAction.onClicked.addListener(function(tab) {
    if (hasActiveSession(tab.id)) {
        chrome.tabs.sendMessage(tab.id, {action: 'destroy-re:view'});
        removeSession(tab.id);
        updateIcon(tab.id, defaultIcon);
    } else {
        createSession(tab.id, tab.url);
        ga('send', 'pageview', '/chrome-extension');
        chrome.tabs.insertCSS(tab.id, {file: 'style/main.css'});
        chrome.tabs.executeScript(tab.id, {file: 'scripts/re-view.js'});
        updateIcon(tab.id, activeIcon);
    }
});

chrome.tabs.onRemoved.addListener(removeSession);
chrome.tabs.onUpdated.addListener(removeSession);

chrome.webRequest.onBeforeRequest.addListener(details => {
    // initial proxy request: get user agent from params of given request url
    // and assign it for all sub-requests of current sub-frame
    var query = details.url.split('?')[1];
    if (!query) {
        return;
    }

    var params = query.split('&').reduce((out, pair) => {
        pair = pair.split('=');
        out[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1]);
        return out;
    }, {});

    if (params.userAgent) {
        userAgentOverride[details.frameId] = {
            userAgent: params.userAgent,
            timeStamp: details.timeStamp
        };
    }

    if (params.url) {
        return {redirectUrl: params.url};
    }
}, {
    urls: [`${chrome.runtime.getURL('proxy')}*`],
    types: ['sub_frame']
}, ['blocking']);

// override user-agent for internal request
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
    var override = userAgentOverride[details.frameId];
    if (override) {
        return {
            requestHeaders: details.requestHeaders.map(header => {
                if (header.name.toLowerCase() === 'user-agent') {
                    header = {
                        name: header.name,
                        value: override.userAgent
                    };
                }
                return header;
            })
        };
    }
}, {
    urls: ['<all_urls>']
}, ['blocking', 'requestHeaders']);

// remove x-frame-options header for Re:view iframes
chrome.webRequest.onHeadersReceived.addListener(details => {
    if (hasActiveSession(details.tabId) && details.frameId) {
        let responseHeaders = details.responseHeaders.filter(h => h.name.toLowerCase() !== 'x-frame-options');
        return {responseHeaders};
    }
}, {
    urls: ['<all_urls>'],
    types: ['sub_frame']
}, ['blocking', 'responseHeaders']);

chrome.runtime.onMessage.addListener((message, sender, response) => {
    switch (message.action) {
        case 'track-event':
            let data = message.data;
            ga('send', 'event', data.category, data.action, data.label);
            break;
        case 'is-review-frame':
            response(hasActiveSession(sender.tab.id) && sender.frameId);
            break;

        case 'is-donated':
            checkIfUserDonated().then(data => response({data}));
            return true;
        case 'get-donation-data':
            getProducts().then(data => response({data}), error => response({error}));
            return true;
        case 'donate':
            donate().then(data => response({data}), error => response({error}));
            return true;
    }
});

cleanUp();
checkIfUserDonated().then(donated => console.log('did user donated?', donated));

function cleanUp() {
    var now = Date.now();
    Object.keys(userAgentOverride).forEach(key => {
        if (userAgentOverride[key].timeStamp + cacheTTL < now) {
            delete userAgentOverride[key];
        }
    });
    setTimeout(cleanUp, cacheTTL);
}

function hasActiveSession(tabId) {
    return tabId in activeSessions;
}

function createSession(tabId, url) {
    activeSessions[tabId] = url;
}

function removeSession(tabId) {
    delete activeSessions[tabId];
}

function updateIcon(tabId, path) {
    chrome.browserAction.setIcon({path, tabId});
}

function getProducts() {
    return new Promise((resolve, reject) => {
        google.payments.inapp.getSkuDetails({
            parameters: inAppParams,
            success: data => {
                let products = data.response.details.inAppProducts || [];
                let product = products.filter(prod => prod.sku === donationItemSKU && prod.state === 'ACTIVE')[0];
                product ? resolve(product) : reject(new Error('No donation product'));
            },
            failure: data => reject(data.response)
        });
    });
}

function getPurchases() {
    return new Promise((resolve, reject) => {
        google.payments.inapp.getPurchases({
            parameters: inAppParams,
            success: data => resolve(data.response.details || []),
            failure: data => reject(data.response)
        });
    });
}

function checkIfUserDonated() {
    if (didDonated) {
        return Promise.resolve(didDonated);
    }

    return getPurchases()
    .then(licenses => didDonated = licenses.some(l => l.sku === donationItemSKU))
    .catch(err => didDonated = false);
}

function donate() {
    return new Promise((resolve, reject) => {
        google.payments.inapp.buy({
            parameters: inAppParams,
            sku: donationItemSKU,
            success: data => {
                broadcast('donate-success');
                resolve(data.response);
            },
            failure: data => {
                broadcast({action: 'donate-failed', data: data.response});
                reject(data.response);
            }
        });
    });
}

function broadcast(message) {
    if (typeof message === 'string') {
        message = {action: message};
    }

    var opt = {frameId: 0};
    Object.keys(activeSessions)
    .forEach(tabId => chrome.tabs.sendMessage(+tabId, message, opt));
}
