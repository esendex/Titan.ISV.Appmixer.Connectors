'use strict';

const assert = require('assert');

const MakeApiCall = require('../../core/MakeApiCall/MakeApiCall.js');

// Minimal Appmixer context mock for MakeApiCall.receive().
function createContext({ content = {}, httpResponse } = {}) {

    const context = {
        auth: {
            apiKey: 'test-api-key',
            accountReference: 'EXUK0000000',
            baseUrl: 'https://api2.example.test/'   // trailing slash on purpose
        },
        messages: { in: { content } },
        CancelError: class CancelError extends Error {
            constructor(message) {
                super(message);
                this.name = 'CancelError';
            }
        },
        sent: [],
        requests: [],
        httpRequest: async options => {
            context.requests.push(options);
            return httpResponse || { status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true } };
        },
        sendJson: (data, port) => {
            context.sent.push({ data, port });
            return Promise.resolve();
        }
    };
    return context;
}

describe('Esendex MakeApiCall', function() {

    it('throws CancelError when the endpoint path is missing', async function() {

        const context = createContext({ content: { method: 'GET' } });

        await assert.rejects(
            () => MakeApiCall.receive(context),
            err => err.name === 'CancelError'
        );
    });

    it('resolves relative paths against the account base URL and injects auth headers', async function() {

        const context = createContext({
            content: {
                url: '/v2/messages',
                method: 'GET',
                // Key-value rows arrive as arrays from the Designer.
                parameters: [{ key: 'pageSize', value: '1' }]
            }
        });

        await MakeApiCall.receive(context);

        const request = context.requests[0];
        // Base URL from auth, trailing slash trimmed by lib.getBaseUrl().
        assert.strictEqual(request.url, 'https://api2.example.test/v2/messages');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.strictEqual(request.headers['AccountReference'], 'EXUK0000000');
        assert.deepStrictEqual(request.params, { pageSize: '1' });

        // Output carries status/headers/body as declared on the out port.
        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data.status, 200);
        assert.deepStrictEqual(context.sent[0].data.body, { ok: true });
    });

    it('passes full URLs through unchanged and merges user headers', async function() {

        const context = createContext({
            content: {
                url: 'https://api.esendex.co.uk/v2/messages',
                method: 'POST',
                body: '{"accountReference": "EXUK0000000"}',
                headers: [{ key: 'X-Custom', value: 'yes' }]
            }
        });

        await MakeApiCall.receive(context);

        const request = context.requests[0];
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/messages');
        assert.strictEqual(request.headers['X-Custom'], 'yes');
        assert.deepStrictEqual(request.data, { accountReference: 'EXUK0000000' });
    });

    it('throws CancelError when the request body is not valid JSON', async function() {

        const context = createContext({
            content: { url: '/v2/messages', method: 'POST', body: '{oops' }
        });

        await assert.rejects(
            () => MakeApiCall.receive(context),
            err => err.name === 'CancelError' && /JSON/.test(err.message)
        );
    });
});
