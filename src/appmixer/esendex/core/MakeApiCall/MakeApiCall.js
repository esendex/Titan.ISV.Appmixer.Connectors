'use strict';

const lib = require('../../lib');

// The key-value inspector delivers rows as [{ key, value }, ...].
function kvToObj(arr) {

    if (!arr || !Array.isArray(arr)) return {};

    const out = {};
    for (const row of arr) {
        if (!row || typeof row !== 'object') continue;
        const key = row.key;
        if (typeof key !== 'string' || key.length === 0) continue;
        out[key] = row.value;
    }
    return out;
}

module.exports = {

    async receive(context) {

        const { url, method, headers: headersKV, parameters: parametersKV, body } = context.messages.in.content;

        if (!url) {
            throw new context.CancelError('API Endpoint Path is required!');
        }
        if (!method) {
            throw new context.CancelError('HTTP Method is required!');
        }

        const extraHeaders = kvToObj(headersKV);
        const queryParams = kvToObj(parametersKV);

        // Relative paths are resolved against the connected account's base URL;
        // full URLs are passed through unchanged.
        const targetUrl = url.startsWith('http://') || url.startsWith('https://')
            ? url
            : `${lib.getBaseUrl(context.auth)}${url.startsWith('/') ? '' : '/'}${url}`;

        const requestOptions = {
            method,
            url: targetUrl,
            headers: {
                // Messaging API endpoints authenticate with X-Api-Key; most reads
                // additionally require the AccountReference header, so both are set
                // by default. User-supplied headers below can override either one.
                'X-Api-Key': context.auth.apiKey,
                'AccountReference': context.auth.accountReference,
                'Content-Type': 'application/json',
                ...extraHeaders
            }
        };

        if (body) {
            try {
                requestOptions.data = typeof body === 'object' ? body : JSON.parse(body);
            } catch (e) {
                throw new context.CancelError('Request Body must be valid JSON.');
            }
        }

        if (Object.keys(queryParams).length > 0) {
            requestOptions.params = queryParams;
        }

        const response = await context.httpRequest(requestOptions);

        return context.sendJson({
            status: response.status,
            headers: response.headers,
            body: response.data
        }, 'out');
    }
};
