'use strict';

const assert = require('assert');

const FindOptOuts = require('../../core/FindOptOuts/FindOptOuts.js');

// A documented sample record from GET /v2/optouts (data.optOuts[]).
const OPTOUT = {
    id: 'b5a5a418-294a-42a1-ae23-ecb2168dcd39',
    accountReference: 'EXUK000',
    channel: 'SMS',
    value: '+447123123123',
    createTimestamp: '2024-07-05T13:59:50.064193Z'
};

// Minimal Appmixer context mock for FindOptOuts.receive(). `pages` is an array
// of API responses served in order, one per httpRequest call - this lets the
// pagination loop be tested with multi-page fixtures.
function createContext({ content = {}, properties = {}, pages, httpError, config = {} } = {}) {

    const defaultPage = { optOuts: [OPTOUT], totalCount: 1, totalPages: 1, currentPage: 1 };
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
            return { data: { data: queue.shift() || { optOuts: [], totalPages: 1 } } };
        },
        sendJson: (data, port) => {
            context.sent.push({ data, port });
            return Promise.resolve();
        }
    };
    return context;
}

describe('Esendex FindOptOuts', function() {

    it('generates output port options without calling the API (array mode)', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            properties: { generateOutputPortOptions: true }
        });

        await FindOptOuts.receive(context);

        assert.strictEqual(context.requests.length, 0);
        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data[0].label, 'Opt-Outs');
        assert.strictEqual(context.sent[0].data[0].value, 'result');
        assert.strictEqual(context.sent[0].data[0].schema.type, 'array');
    });

    it('queries with max page size, auth headers and mapped filter parameters', async function() {

        const context = createContext({
            content: {
                outputType: 'array',
                address: '+447123123123',
                optOutMethod: 'Stop',
                startTime: '2026-01-01T00:00:00Z'
                // channel, endTime, sortBy, sortOrder left empty on purpose:
                // the parameters must be omitted so the API applies its defaults.
            }
        });

        await FindOptOuts.receive(context);

        const request = context.requests[0];
        assert.strictEqual(request.url, 'https://api.esendex.co.uk/v2/optouts');
        assert.strictEqual(request.headers['X-Api-Key'], 'test-api-key');
        assert.strictEqual(request.headers['AccountReference'], 'EXUK0000000');
        // camelCase inputs are mapped to the API's documented parameter casing.
        assert.deepStrictEqual(request.params, {
            PageSize: 1000,
            PageNo: 1,
            Address: '+447123123123',
            OptOutMethod: 'Stop',
            StartTime: '2026-01-01T00:00:00Z'
        });

        assert.strictEqual(context.sent[0].port, 'out');
        assert.deepStrictEqual(context.sent[0].data, { result: [OPTOUT], count: 1 });
    });

    it('collects every page when the result spans multiple pages', async function() {

        const second = { ...OPTOUT, id: 'second-optout' };
        const context = createContext({
            content: { outputType: 'array' },
            pages: [
                { optOuts: [OPTOUT], totalPages: 2, currentPage: 1 },
                { optOuts: [second], totalPages: 2, currentPage: 2 }
            ]
        });

        await FindOptOuts.receive(context);

        assert.strictEqual(context.requests.length, 2);
        assert.strictEqual(context.requests[0].params.PageNo, 1);
        assert.strictEqual(context.requests[1].params.PageNo, 2);
        assert.deepStrictEqual(context.sent[0].data, { result: [OPTOUT, second], count: 2 });
    });

    it('sends to the notFound port when no opt-out matches', async function() {

        const context = createContext({
            content: { outputType: 'array' },
            pages: [{ optOuts: [], totalPages: 1 }]
        });

        await FindOptOuts.receive(context);

        assert.strictEqual(context.sent.length, 1);
        assert.strictEqual(context.sent[0].port, 'notFound');
        assert.deepStrictEqual(context.sent[0].data, {});
    });

    it('outputs the first record with index and count in first mode', async function() {

        const other = { ...OPTOUT, id: 'second-optout' };
        const context = createContext({
            content: { outputType: 'first' },
            pages: [{ optOuts: [OPTOUT, other], totalPages: 1 }]
        });

        await FindOptOuts.receive(context);

        assert.strictEqual(context.sent[0].port, 'out');
        assert.strictEqual(context.sent[0].data.id, OPTOUT.id);
        assert.strictEqual(context.sent[0].data.index, 0);
        assert.strictEqual(context.sent[0].data.count, 2);
    });

    it('rejects an oversized array output with a clear error', async function() {

        // 100-byte message limit -> 70-byte budget; a single real opt-out exceeds it.
        const context = createContext({
            content: { outputType: 'array' },
            pages: [{ optOuts: [OPTOUT], totalPages: 1 }],
            config: { messageLimitBytes: '100' }
        });

        await assert.rejects(
            () => FindOptOuts.receive(context),
            err => err.name === 'CancelError' && /Too many opt-outs/.test(err.message)
        );
    });

    it('surfaces the structured Esendex error list on API failures', async function() {

        const httpError = new Error('Request failed with status code 400');
        httpError.response = {
            data: {
                errors: [{ errorCode: 'invalidRequest', errorMessage: 'StartTime is invalid.' }]
            }
        };

        const context = createContext({
            content: { outputType: 'array' },
            httpError
        });

        await assert.rejects(
            () => FindOptOuts.receive(context),
            err => /invalidRequest: StartTime is invalid\./.test(err.message)
        );
    });
});
