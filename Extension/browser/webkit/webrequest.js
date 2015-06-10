/**
 * This file is part of Adguard Browser Extension (https://github.com/AdguardTeam/AdguardBrowserExtension).
 *
 * Adguard Browser Extension is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Adguard Browser Extension is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Adguard Browser Extension.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Process request
 * @param requestDetails
 * @returns {boolean} False if request must be blocked
 */
function onBeforeRequest(requestDetails) {

    var tab = requestDetails.tab;
    var requestUrl = requestDetails.requestUrl;
    var requestType = requestDetails.requestType;

    if (requestType == "DOCUMENT" || requestType == "SUBDOCUMENT") {
        framesMap.recordFrame(tab, requestDetails.frameId, requestUrl, requestType);
    }

    if (requestType == "DOCUMENT") {
        //reset tab button state
        EventNotifier.notifyListeners(EventNotifierTypes.UPDATE_TAB_BUTTON_STATE, tab, true);
        return true;
    }

    if (!UrlUtils.isHttpRequest(requestUrl)) {
        return true;
    }

    var referrerUrl = framesMap.getFrameUrl(tab, requestDetails.requestFrameId);

    var requestRule = webRequestService.getRuleForRequest(tab, requestUrl, referrerUrl, requestType);

    webRequestService.postProcessRequest(tab, requestUrl, referrerUrl, requestType, requestRule);

    return !webRequestService.isRequestBlockedByRule(requestRule);
}

/**
 * If page URL is whitelisted in standalone Adguard, we should forcibly set Referrer value to this page URL.
 * The problem is that standalone Adguard looks at the page referrer to check if it should bypass this request or not.
 * Also there's an issue with Opera browser, it misses referrer for some requests.
 *
 * @param requestDetails Request details
 * @returns {*}
 */
function onBeforeSendHeaders(requestDetails) {

    var tab = requestDetails.tab;
    var headers = requestDetails.requestHeaders;

    if (framesMap.isTabAdguardWhiteListed(tab)) {
        //retrieve main frame url
        var mainFrameUrl = framesMap.getFrameUrl(tab, 0);
        headers = Utils.setHeaderValue(headers, 'Referer', mainFrameUrl);
        return {requestHeaders: headers};
    }

    if (requestDetails.requestType === 'DOCUMENT') {
        //save ref header
        var refHeader = Utils.findHeaderByName(headers, 'Referer');
        if (refHeader) {
            framesMap.recordFrameReferrerHeader(tab, refHeader.value);
        }
    }

    return {};
}

function onHeadersReceived(requestDetails) {

    var tab = requestDetails.tab;
    var requestUrl = requestDetails.requestUrl;
    var responseHeaders = requestDetails.responseHeaders;
    var requestType = requestDetails.requestType;
    //retrieve referrer
    var referrerUrl = framesMap.getFrameUrl(tab, requestDetails.requestFrameId);

    webRequestService.processRequestResponse(tab, requestUrl, referrerUrl, requestType, responseHeaders);

    if (requestType == "DOCUMENT") {
        //safebrowsing check
        filterSafebrowsing(tab, requestUrl);
    }
}

function filterSafebrowsing(tab, mainFrameUrl) {

    if (framesMap.isTabAdguardDetected(tab) || framesMap.isTabProtectionDisabled(tab) || framesMap.isTabWhiteListed(tab)) {
        return;
    }

    var frameData = framesMap.getMainFrame(tab);
    var referrerUrl = Utils.getSafebrowsingBackUrl(frameData);

    antiBannerService.getRequestFilter().checkSafebrowsingFilter(mainFrameUrl, referrerUrl, function (safebrowsingUrl) {
        UI.openTab(safebrowsingUrl, {
            onOpen: function () {
                tab.close();
            }
        });
    });
}

ext.webRequest.onBeforeRequest.addListener(onBeforeRequest, ["<all_urls>"]);

ext.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, ["<all_urls>"]);

ext.webRequest.onHeadersReceived.addListener(onHeadersReceived, ["<all_urls>"]);

// AG for Windows and Mac checks either request signature or request Referer to authorize request.
// Referer cannot be forged by the website so it's ok for add-on authorization.
if (typeof chrome !== 'undefined') {

    chrome.webRequest.onBeforeSendHeaders.addListener(function callback(details) {

        var headers = Utils.setHeaderValue(details.requestHeaders, 'Referer', 'http://injections.adguard.com/');
        return {requestHeaders: headers};

    }, {urls: ["*://injections.adguard.com/*"]}, ["requestHeaders"]);
}

function parseCssRuleFromUrl(requestUrl) {
    if (!requestUrl) {
        return null;
    }
    var filterIdAndRuleText = decodeURIComponent(StringUtils.substringAfter(requestUrl, '#'));
    var filterId = StringUtils.substringBefore(filterIdAndRuleText, ';');
    var ruleText = StringUtils.substringAfter(filterIdAndRuleText, ';');
    return {
        filterId: filterId,
        ruleText: ruleText
    }
}

function onCssRuleHit(requestDetails) {
    var domain = framesMap.getFrameDomain(requestDetails.tab);
    var rule = parseCssRuleFromUrl(requestDetails.requestUrl);
    if (rule) {
        filterRulesHitCount.addRuleHit(domain, rule.ruleText, rule.filterId);
    }
}

ext.webRequest.onBeforeRequest.addListener(onCssRuleHit, ["chrome-extension://*/elemhidehit.png"]);

var handlerBehaviorTimeout = null;
EventNotifier.addListener(function (event) {
    switch (event) {
        case EventNotifierTypes.ADD_RULE:
        case EventNotifierTypes.ADD_RULES:
        case EventNotifierTypes.REMOVE_RULE:
        case EventNotifierTypes.UPDATE_FILTER_RULES:
        case EventNotifierTypes.ENABLE_FILTER:
        case EventNotifierTypes.DISABLE_FILTER:
            if (handlerBehaviorTimeout != null) {
                clearTimeout(handlerBehaviorTimeout);
            }
            handlerBehaviorTimeout = setTimeout(function () {
                handlerBehaviorTimeout = null;
                ext.webRequest.handlerBehaviorChanged();
            }, 3000);
    }
});