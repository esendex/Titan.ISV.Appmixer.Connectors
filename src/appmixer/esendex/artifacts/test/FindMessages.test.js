'use strict';

const assert = require('assert');

const FindMessages = require('../../core/FindMessages/FindMessages.js');

// A documented sample record from GET /v2/messages (trimmed).
const MESSAGE = {
    messageId: '8eb5fe15-07d7-49a7-b17a-3011de6d949f',
    requestId: 'c5a5eddc-b0ad-4147-8e97-e2e25d9ddfb0',
    status: 'Sent',
    direction: 'Outbound'
};

// Minimal Appmixer context mock for FindMessages.receive(). `pages` is an array
// of API responses served in order, one per httpRequest call - this lets the
// pagination loop be tested with multi-page fixtures.
function createContext({ content = {}, properties = {}, pages, httpError, config = {} } = {}) {

    const defaultPage = { messages: [MESSAGE], totalCount: 1, totalPages: 1, currentPage: 1 };
    const queue = (pages || [defaultPage]).slice();

    const context = {
        auth: {
            apiKey: 'test-api-key',
            accountReference: 'EXUK0000000'
        },
        properties,
        config,
        logs: [],
        log: async entry => { context.logs.push(entry); },
        messages: { in: { content } },
        CancelError: class CancelError extends Error {
            constructor(message) {
                super(message);
                this.name = 'CancelError';
            }
        },
        sent: [],
        requests: [],
        logs: [],
        log: async entry => { context.logs.push(entry); },
        httpRequest: async options => {
            context.requests.push(options);
            if (httpError) {
                throw httpError;
            }
            return { data: { data: queue.shift() || { messages: [], totalPages: 1 } } };
        },
        sendJson: (data, port) => {
            context.sent.push({ data, port });
            return Promise.resolve();
        }
    };
    return context;
}

describe('Esendex FindMessages', function() {

    it('generates output port options without calling the API (array mode)', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            properties: { generateOutputPortOptions: true }
        });

        await FindMessages.receive(context);

        assert.strictEqual(context.requests.length, 0);
        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data[0].value, 'result');
        assert.strictEqual(context.sent[0].data[0].schema.type, 'array');
    });

    it('queries with max page size, auth headers and only the provided filters', async function() {

        const context = createContext({
            content: {
                outputType: 'array',
                msisdn: '+447700900123',
                direction: 'Outbound'
            }
        });

        await FindMessages.receive(context);

        const request = context.requests[0];
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/messages');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.strictEqual(request.headers['AccountReference'], 'EXUK0000000');
        assert.deepStrictEqual(request.params, {
            pageSize: 1000,
            pageNo: 1,
            msisdn: '+447700900123',
            direction: 'Outbound'
        });

        assert.strictEqual(context.sent[0].port, 'out');
        assert.deepStrictEqual(context.sent[0].data, { result: [MESSAGE], count: 1 });
    });

    it('collects every page when the result spans multiple pages', async function() {

        const second = { ...MESSAGE, messageId: 'second-message' };
        const third = { ...MESSAGE, messageId: 'third-message' };
        const context = createContext({
            content: { outputType: 'array' },
            pages: [
                { messages: [MESSAGE], totalPages: 3, currentPage: 1 },
                { messages: [second], totalPages: 3, currentPage: 2 },
                { messages: [third], totalPages: 3, currentPage: 3 }
            ]
        });

        await FindMessages.receive(context);

        assert.strictEqual(context.requests.length, 3);
        assert.strictEqual(context.requests[0].params.pageNo, 1);
        assert.strictEqual(context.requests[2].params.pageNo, 3);
        assert.deepStrictEqual(context.sent[0].data, { result: [MESSAGE, second, third], count: 3 });
    });

    it('sends to the notFound port when no message matches', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            pages: [{ messages: [], totalPages: 1 }]
        });

        await FindMessages.receive(context);

        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.sent[0].port, 'notFound');
        assert.deepStrictEqual(context.sent[0].data, {});
    });

    it('outputs the first record with index and count in first mode', async function() {

        const other = { ...MESSAGE, messageId: 'second-message' };
        const context = createContext({
            content: { outputType: 'first' },
            pages: [{ messages: [MESSAGE, other], totalPages: 1 }]
        });

        await FindMessages.receive(context);

        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data.messageId, MESSAGE.messageId);
        assert.strictEqual(context.sent[0].data.index, 0);
        assert.strictEqual(context.sent[0].data.count, 2);
    });

    it('rejects an oversized array output with a clear error', async function() {

        // 100-byte message limit -> 70-byte budget; a single real message exceeds it.
        const context = createContext({
            content: { outputType: 'array' },
            pages: [{ messages: [MESSAGE], totalPages: 1 }],
            config: { messageLimitBytes: '100' }
        });

        await assert.rejects(
            () => FindMessages.receive(context),
            err => err.name === 'CancelError' && /Too many messages/.test(err.message)
        );
    });

    it('surfaces the structured Esendex error list on API failures', async function() {

        const httpError = new Error('Request failed with status code 401');
        httpError.response = {
            data: {
                errors: [{ errorCode: 'unauthenticatedError', errorMessage: 'Request was unauthenticated' }]
            }
        };

        const context = createContext({
            content: { outputType: 'array' },
            httpError
        });

        await assert.rejects(
            () => FindMessages.receive(context),
            err => /unauthenticatedError: Request was unauthenticated/.test(err.message)
        );
    });
});
